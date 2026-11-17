import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  newElementWith,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { unsafeNarrow } from "../../unsafe-narrow.js";
import type { CanvasCommand, WhiteboardAddElement, WhiteboardOperation } from "../../whiteboard.js";
import { arrowBetween, AUTHOR_STROKE_COLORS, userEditPatches, type WhiteboardElement } from "../../whiteboard-scene.js";

const API = "/desktop/whiteboard/api";
const fragment = new URLSearchParams(location.hash.slice(1));
const session = fragment.get("session") ?? "";
const authorization = `Bearer ${fragment.get("token") ?? ""}`;
const DEFAULT_BOX = { width: 200, height: 80 };
const ARROW_GAP = 8;

/** Window after a pointer or key event in which scene changes count as the user's. */
const USER_INPUT_WINDOW_MS = 1500;

/** Element versions as last attributed; see userEditPatches. */
const seenVersions = new Map<string, number>();
let lastUserInputAt = 0;

for (const type of ["pointerdown", "pointerup", "keydown", "paste", "drop"]) {
  window.addEventListener(type, () => { lastUserInputAt = Date.now(); }, true);
}

function recordSeen(elements: readonly ExcalidrawElement[]): void {
  seenVersions.clear();

  for (const element of elements) seenVersions.set(element.id, element.version);
}

/** Reattributes the user's changes and puts each element back in its author's color. */
function handleChange(api: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[], appState: AppState): void {
  const inProgress = appState.newElement || appState.editingTextElement || appState.resizingElement
    || appState.multiElement || appState.selectedElementsAreBeingDragged || appState.isResizing || appState.isRotating;

  if (inProgress) return;

  // Excalidraw itself reflows text when fonts load; only changes right after
  // the user's own input are theirs.
  if (Date.now() - lastUserInputAt > USER_INPUT_WINDOW_MS) {
    recordSeen(elements);

    return;
  }

  // SAFETY: Excalidraw elements carry every WhiteboardElement field; only customData's
  // declared type is wider than the authorship fields read from it.
  const patches = new Map(userEditPatches(unsafeNarrow<readonly WhiteboardElement[]>(elements), seenVersions).map((patch) => [patch.id, patch]));

  if (patches.size === 0) {
    recordSeen(elements);

    return;
  }

  const next = api.getSceneElementsIncludingDeleted().map((element: ExcalidrawElement) => {
    const patch = patches.get(element.id);

    if (!patch) return element;

    return newElementWith(element, {
      strokeColor: patch.strokeColor,
      customData: { ...element.customData, author: patch.author, lastEditor: patch.lastEditor },
    });
  });

  recordSeen(next);
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
}

interface BoardPoint {
  x: number;
  y: number;
}

interface LabelFont {
  fontSize?: number;
}

/** Geometry and fill the assistant may change on an element. */
interface ElementChanges {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  fillStyle?: "solid";
}

function requirePosition(spec: WhiteboardAddElement): BoardPoint {
  if (spec.x === undefined || spec.y === undefined) {
    throw new Error(`A ${spec.type} needs x and y.`);
  }

  return { x: spec.x, y: spec.y };
}

function toSkeleton(spec: WhiteboardAddElement): ExcalidrawElementSkeleton {
  const { x, y } = requirePosition(spec);

  if (spec.type === "text") {
    if (spec.text === undefined) throw new Error("A text element needs text.");

    const text: ExcalidrawElementSkeleton = { type: "text", x, y, text: spec.text };

    if (spec.id) text.id = spec.id;

    if (spec.font_size) text.fontSize = spec.font_size;

    return text;
  }

  if (spec.type === "line") {
    const line: ExcalidrawElementSkeleton = { type: "line", x, y, width: spec.width ?? 100, height: spec.height ?? 0 };

    if (spec.id) line.id = spec.id;

    return line;
  }

  // SAFETY: Only arrows reach here besides shapes, and addElements handles arrows separately.
  const boxType = spec.type as "rectangle" | "ellipse" | "diamond";

  const box: ExcalidrawElementSkeleton = {
    type: boxType,
    x,
    y,
    width: spec.width ?? DEFAULT_BOX.width,
    height: spec.height ?? DEFAULT_BOX.height,
  };

  if (spec.id) box.id = spec.id;

  if (spec.text !== undefined) box.label = { text: spec.text, ...fontSize(spec.font_size) };

  if (spec.background_color) {
    box.backgroundColor = spec.background_color;
    box.fillStyle = "solid";
  }

  return box;
}

function fontSize(size: number | undefined): LabelFont {
  const value: LabelFont = {};

  if (size) value.fontSize = size;

  return value;
}

/** The board while a batch of operations applies; nothing reaches the canvas unless every operation succeeds. */
class Draft {
  readonly elements = new Map<string, ExcalidrawElement>();
  readonly originalIds: Set<string>;
  /** Elements the assistant drew or edited in this batch. */
  readonly edited = new Set<string>();
  readonly moved = new Set<string>();

  constructor(current: readonly ExcalidrawElement[]) {
    for (const element of current) this.elements.set(element.id, element);

    this.originalIds = new Set(this.elements.keys());
  }

  live(id: string): ExcalidrawElement {
    const element = this.elements.get(id);

    if (!element || element.isDeleted) throw new Error(`No element with id "${id}" on the board.`);

    return element;
  }

  labelsOf(id: string): ExcalidrawElement[] {
    return [...this.elements.values()].filter((element) =>
      !element.isDeleted && element.type === "text" && element.containerId === id);
  }

  edit(element: ExcalidrawElement): void {
    this.elements.set(element.id, element);
    this.edited.add(element.id);
  }

  /** Records a structural change, such as a new binding, that is not an edit by anyone. */
  replace(element: ExcalidrawElement): void {
    this.elements.set(element.id, element);
  }

  apply(operation: WhiteboardOperation): void {
    switch (operation.op) {
      case "add": {
        this.add(operation.elements);

        break;
      }

      case "update": {
        this.update(operation);

        break;
      }

      case "delete": {
        for (const id of operation.ids) this.remove(this.live(id));

        break;
      }

      case "clear": {
        for (const element of this.elements.values()) {
          if (!element.isDeleted) this.remove(element);
        }

        break;
      }
    }
  }

  private add(specs: WhiteboardAddElement[]): void {
    for (const spec of specs) {
      const existing = spec.id ? this.elements.get(spec.id) : undefined;

      if (existing && !existing.isDeleted) throw new Error(`An element with id "${spec.id}" already exists.`);
    }

    const nodes = specs.flatMap((spec) => spec.type === "arrow" ? [] : [toSkeleton(spec)]);

    for (const element of convertToExcalidrawElements(nodes, { regenerateIds: false })) this.edit(element);

    for (const spec of specs) {
      if (spec.type === "arrow") this.addArrow(spec);
    }
  }

  private addArrow(spec: WhiteboardAddElement): void {
    const skeleton: ExcalidrawElementSkeleton = { type: "arrow", x: 0, y: 0 };

    if (spec.id) skeleton.id = spec.id;

    if (spec.text !== undefined) skeleton.label = { text: spec.text };

    let ends: [ExcalidrawElement, ExcalidrawElement] | undefined;

    if (spec.from !== undefined || spec.to !== undefined) {
      if (spec.from === undefined || spec.to === undefined) throw new Error("An arrow needs both from and to, or neither.");

      ends = [this.live(spec.from), this.live(spec.to)];

      const placement = arrowBetween(ends[0], ends[1]);
      skeleton.x = placement.x;
      skeleton.y = placement.y;
      skeleton.points = unsafeNarrow(placement.points);
    } else {
      const { x, y } = requirePosition(spec);
      skeleton.x = x;
      skeleton.y = y;
      skeleton.width = spec.width ?? 100;
      skeleton.height = spec.height ?? 0;
    }

    const [converted, ...labels] = convertToExcalidrawElements([skeleton], { regenerateIds: false });

    if (!converted) throw new Error("The arrow could not be created.");

    let arrow = converted;

    if (ends) {
      const [start, end] = ends;

      arrow = newElementWith(arrow, unsafeNarrow({
        startBinding: { elementId: start.id, focus: 0, gap: ARROW_GAP },
        endBinding: { elementId: end.id, focus: 0, gap: ARROW_GAP },
      }));

      for (const target of ends) {
        const current = this.live(target.id);

        this.replace(newElementWith(current, {
          boundElements: [...(current.boundElements ?? []), { id: arrow.id, type: "arrow" }],
        }));
      }
    }

    this.edit(arrow);

    for (const label of labels) this.edit(label);
  }

  private update(operation: Extract<WhiteboardOperation, { op: "update" }>): void {
    const target = this.live(operation.id);
    const labels = this.labelsOf(target.id);
    const dx = operation.x === undefined ? 0 : operation.x - target.x;
    const dy = operation.y === undefined ? 0 : operation.y - target.y;
    const updates: ElementChanges = {};

    if (dx !== 0 || dy !== 0) {
      updates.x = target.x + dx;
      updates.y = target.y + dy;
    }

    if (operation.width !== undefined) updates.width = operation.width;

    if (operation.height !== undefined) updates.height = operation.height;

    if (operation.background_color !== undefined) {
      updates.backgroundColor = operation.background_color;
      updates.fillStyle = "solid";
    }

    if (operation.text !== undefined && target.type !== "text" && labels.length === 0) {
      throw new Error(`Element "${target.id}" has no text to change.`);
    }

    if (operation.text !== undefined && target.type === "text") {
      this.edit(newElementWith(target, { ...updates, text: operation.text, originalText: operation.text }));
    } else {
      this.edit(newElementWith(target, updates));
    }

    for (const label of labels) {
      if (label.type !== "text") continue;

      const text = operation.text ?? label.text;
      this.edit(newElementWith(label, { x: label.x + dx, y: label.y + dy, text, originalText: text }));
    }

    this.moved.add(target.id);
  }

  private remove(element: ExcalidrawElement): void {
    this.edit(newElementWith(element, { isDeleted: true }));

    for (const label of this.labelsOf(element.id)) this.edit(newElementWith(label, { isDeleted: true }));
  }

  /** Re-routes arrows attached to moved elements, then stamps the assistant's authorship. */
  finish(): ExcalidrawElement[] {
    for (const element of this.elements.values()) {
      if (element.isDeleted || element.type !== "arrow" || !element.startBinding || !element.endBinding) continue;

      const { startBinding, endBinding } = element;

      if (!this.moved.has(startBinding.elementId) && !this.moved.has(endBinding.elementId)) continue;

      const start = this.elements.get(startBinding.elementId);
      const end = this.elements.get(endBinding.elementId);

      if (!start || !end || start.isDeleted || end.isDeleted) continue;

      const placement = arrowBetween(start, end);
      this.replace(newElementWith(element, { x: placement.x, y: placement.y, points: unsafeNarrow(placement.points) }));
    }

    for (const id of this.edited) {
      const element = this.elements.get(id);

      if (!element) continue;

      const drawn = !this.originalIds.has(id);
      const author = drawn ? "assistant" : element.customData?.author ?? "user";

      this.elements.set(id, {
        ...element,
        strokeColor: drawn ? AUTHOR_STROKE_COLORS.assistant : element.strokeColor,
        customData: { ...element.customData, author, lastEditor: "assistant" },
      });
    }

    // Re-measure only what this batch changed; re-measuring untouched labels
    // moves them inside their containers.
    const restored = restoreElements([...this.elements.values()], null, { refreshDimensions: true, repairBindings: true });

    return restored.map((element: ExcalidrawElement) => this.edited.has(element.id) ? element : this.elements.get(element.id) ?? element);
  }
}

/**
 * Loads the glyphs a batch writes before Excalidraw measures them; otherwise
 * Chinese text is sized with a fallback font and clipped once the
 * hand-drawn Xiaolai font arrives.
 */
async function loadGlyphs(operations: WhiteboardOperation[]): Promise<void> {
  const texts = operations.flatMap((operation) => {
    if (operation.op === "add") return operation.elements.flatMap((element) => element.text ?? []);

    return operation.op === "update" && operation.text !== undefined ? [operation.text] : [];
  });

  if (texts.length > 0) await document.fonts.load("20px Excalifont, Xiaolai", texts.join(""));
}

async function applyOperations(api: ExcalidrawImperativeAPI, operations: WhiteboardOperation[]): Promise<void> {
  await loadGlyphs(operations);

  const draft = new Draft(api.getSceneElementsIncludingDeleted());

  for (const operation of operations) draft.apply(operation);

  const next = draft.finish();
  recordSeen(next);
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  // Leave room for the toolbars that cover the edges of the small window.
  api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.6, animate: true });
}

async function boardImage(api: ExcalidrawImperativeAPI): Promise<string | undefined> {
  const elements = api.getSceneElements();

  if (elements.length === 0) return undefined;

  const blob = await exportToBlob({
    elements,
    appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff" },
    files: api.getFiles(),
    mimeType: "image/png",
    maxWidthOrHeight: 1600,
  });

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

interface CanvasReply {
  session: string;
  request_id: string;
  ok: boolean;
  error?: string;
  elements?: readonly ExcalidrawElement[];
  image?: string;
}

async function runCommand(api: ExcalidrawImperativeAPI, command: CanvasCommand): Promise<void> {
  const reply: CanvasReply = { session, request_id: command.request_id, ok: true };

  try {
    if (command.kind === "update") await applyOperations(api, command.operations);

    reply.elements = api.getSceneElementsIncludingDeleted();

    if (command.kind === "read" && command.include_image) {
      const image = await boardImage(api);

      if (image) reply.image = image;
    }
  } catch (error) {
    reply.ok = false;
    reply.error = error instanceof Error ? error.message : String(error);
  }

  await fetch(`${API}/result`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "text/plain" },
    body: JSON.stringify(reply),
  });
}

/** Receives the host's commands until the server ends the stream. */
async function listen(api: ExcalidrawImperativeAPI): Promise<void> {
  const response = await fetch(`${API}/stream?session=${encodeURIComponent(session)}`, {
    headers: { Authorization: authorization },
    cache: "no-store",
  });

  if (!response.ok || !response.body) return;

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let queue = Promise.resolve();

  for (;;) {
    const { value, done } = await reader.read();

    if (done) return;

    buffer += value;

    let end = buffer.indexOf("\n\n");

    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");

      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;

        // SAFETY: The token-authenticated server sends only CanvasCommand events on this stream.
        const command = unsafeNarrow<CanvasCommand>(JSON.parse(line.slice("data: ".length)));
        queue = queue.then(() => runCommand(api, command));
      }
    }
  }
}

/**
 * A small tag above Excalidraw's bottom bar; the bar itself drops custom
 * footer content in small windows and fills with selection actions.
 */
function Legend() {
  return (
    <div style={{
      position: "fixed", bottom: 76, left: 12, zIndex: 5, pointerEvents: "none",
      display: "flex", gap: 8, alignItems: "center", padding: "2px 6px", borderRadius: 6,
      background: "rgba(255,255,255,0.85)", fontSize: 11, fontFamily: "system-ui, sans-serif", whiteSpace: "nowrap",
    }}>
      <span><span style={{ color: AUTHOR_STROKE_COLORS.assistant }}>●</span> ChatGPT</span>
      <span><span style={{ color: AUTHOR_STROKE_COLORS.user }}>●</span> 我</span>
    </div>
  );
}

function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (!api) return;

    void listen(api).catch(() => undefined).finally(() => setClosed(true));
  }, [api]);

  return (
    <>
      <Excalidraw
        excalidrawAPI={setApi}
        langCode="zh-CN"
        initialData={{ appState: { currentItemStrokeColor: AUTHOR_STROKE_COLORS.user } }}
        onChange={(elements: readonly ExcalidrawElement[], appState: AppState) => { if (api) handleChange(api, elements, appState); }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false } }}
      />
      <Legend />
      {closed && (
        <div style={{
          position: "fixed", inset: 0, display: "grid", placeItems: "center",
          background: "rgba(255,255,255,0.85)", fontFamily: "system-ui, sans-serif", zIndex: 10,
        }}>
          白板已关闭
        </div>
      )}
    </>
  );
}

const root = document.getElementById("root");

if (root) createRoot(root).render(<App />);
