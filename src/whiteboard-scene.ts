/**
 * Whiteboard scene rules shared by the server and the canvas page: who drew
 * each element, which color that author draws in, and the compact element
 * description returned to the model.
 *
 * Authorship lives in each Excalidraw element's `customData`, so a saved
 * scene keeps it without any format change.
 */

export type WhiteboardAuthor = "assistant" | "user";

/** Stroke (and text) color of every element, decided by its original author. */
export const AUTHOR_STROKE_COLORS: Readonly<Record<WhiteboardAuthor, string>> = {
  assistant: "#1971c2",
  user: "#e8590c",
};

export interface WhiteboardAuthorship {
  author?: string | undefined;
  lastEditor?: string | undefined;
}

/** The part of an Excalidraw element these rules read. */
export interface WhiteboardElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  isDeleted: boolean;
  strokeColor: string;
  text?: string | undefined;
  containerId?: string | null | undefined;
  startBinding?: { elementId: string } | null | undefined;
  endBinding?: { elementId: string } | null | undefined;
  customData?: WhiteboardAuthorship | null | undefined;
}

export interface AuthorshipPatch {
  id: string;
  author: WhiteboardAuthor;
  lastEditor: WhiteboardAuthor;
  strokeColor: string;
}

export function parseAuthor(value: string | undefined): WhiteboardAuthor | undefined {
  return value === "assistant" || value === "user" ? value : undefined;
}

/**
 * Attributes every element change the canvas did not get from the assistant
 * to the user, and forces each element's stroke color back to its author's.
 *
 * `seenVersions` holds the version of every element as last attributed,
 * including the versions the assistant's own changes produced. An element
 * whose id was never seen was drawn (or pasted) by the user; one whose version
 * moved on was edited by the user, who becomes its last editor while the
 * original author stays.
 */
export function userEditPatches(
  elements: readonly WhiteboardElement[],
  seenVersions: ReadonlyMap<string, number>,
): AuthorshipPatch[] {
  const patches: AuthorshipPatch[] = [];

  for (const element of elements) {
    if (element.isDeleted) continue;

    const seenVersion = seenVersions.get(element.id);
    const recordedAuthor = parseAuthor(element.customData?.author ?? undefined);
    const author = seenVersion === undefined ? "user" : recordedAuthor ?? "user";
    const edited = seenVersion !== element.version;
    const lastEditor = edited ? "user" : parseAuthor(element.customData?.lastEditor ?? undefined) ?? author;
    const strokeColor = AUTHOR_STROKE_COLORS[author];

    if (
      author === recordedAuthor
      && lastEditor === element.customData?.lastEditor
      && strokeColor === element.strokeColor
    ) continue;

    patches.push({ id: element.id, author, lastEditor, strokeColor });
  }

  return patches;
}

export interface WhiteboardElementSummary {
  id: string;
  type: string;
  /** Text of a text element, or the label inside a shape or on an arrow. */
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Element an arrow starts from. */
  from?: string;
  /** Element an arrow points to. */
  to?: string;
  author: WhiteboardAuthor;
  last_editor: WhiteboardAuthor;
}

/** Describes the visible elements; labels are folded into their shape or arrow. */
export function summarizeScene(elements: readonly WhiteboardElement[]): WhiteboardElementSummary[] {
  const visible = elements.filter((element) => !element.isDeleted);
  const visibleIds = new Set(visible.map((element) => element.id));
  const labels = new Map<string, string>();

  for (const element of visible) {
    if (element.containerId && visibleIds.has(element.containerId) && element.text !== undefined) {
      labels.set(element.containerId, element.text);
    }
  }

  const summaries: WhiteboardElementSummary[] = [];

  for (const element of visible) {
    if (element.containerId && visibleIds.has(element.containerId)) continue;

    const author = parseAuthor(element.customData?.author ?? undefined) ?? "user";

    const summary: WhiteboardElementSummary = {
      id: element.id,
      type: element.type,
      x: Math.round(element.x),
      y: Math.round(element.y),
      width: Math.round(element.width),
      height: Math.round(element.height),
      author,
      last_editor: parseAuthor(element.customData?.lastEditor ?? undefined) ?? author,
    };

    const text = labels.get(element.id) ?? element.text;

    if (text !== undefined) summary.text = text;

    if (element.startBinding) summary.from = element.startBinding.elementId;

    if (element.endBinding) summary.to = element.endBinding.elementId;

    summaries.push(summary);
  }

  return summaries;
}

export interface WhiteboardChanges {
  /** Visible elements a batch drew or edited, including shapes whose label it changed. */
  changed: WhiteboardElementSummary[];
  /** Elements the batch deleted, not counting labels deleted with their shape. */
  deleted: string[];
  /** Visible elements on the board afterwards. */
  element_count: number;
}

/** Describes only what one batch changed, so drawing in several calls does not resend the whole board. */
export function summarizeChanges(elements: readonly WhiteboardElement[], changedIds: readonly string[]): WhiteboardChanges {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const touched = new Set<string>();
  const deleted: string[] = [];

  for (const id of changedIds) {
    const element = byId.get(id);

    if (!element) continue;

    if (element.isDeleted) {
      if (!element.containerId) deleted.push(id);

      continue;
    }

    touched.add(element.containerId ?? id);
  }

  const summaries = summarizeScene(elements);

  return {
    changed: summaries.filter((summary) => touched.has(summary.id)),
    deleted,
    element_count: summaries.length,
  };
}

export interface WhiteboardBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArrowPlacement {
  x: number;
  y: number;
  points: [[number, number], [number, number]];
}

/** Gap between an arrow tip and the element it points at, in scene units. */
const ARROW_GAP = 8;

/** A straight arrow from the edge of `start` toward the center of `end`, stopping at the edge of `end`. */
export function arrowBetween(start: WhiteboardBox, end: WhiteboardBox): ArrowPlacement {
  const startCenter = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
  const endCenter = { x: end.x + end.width / 2, y: end.y + end.height / 2 };
  const dx = endCenter.x - startCenter.x;
  const dy = endCenter.y - startCenter.y;
  const length = Math.hypot(dx, dy);

  if (length === 0) {
    return { x: startCenter.x, y: startCenter.y, points: [[0, 0], [0, 0]] };
  }

  // Distance from a box's center to its edge along the arrow's direction.
  const edgeDistance = (box: WhiteboardBox) => Math.min(
    dx === 0 ? Infinity : (box.width / 2) * (length / Math.abs(dx)),
    dy === 0 ? Infinity : (box.height / 2) * (length / Math.abs(dy)),
  );

  const startOffset = Math.min(edgeDistance(start) + ARROW_GAP, length / 2);
  const endOffset = Math.min(edgeDistance(end) + ARROW_GAP, length / 2);
  const ux = dx / length;
  const uy = dy / length;
  const x = startCenter.x + ux * startOffset;
  const y = startCenter.y + uy * startOffset;
  const span = length - startOffset - endOffset;

  return { x, y, points: [[0, 0], [ux * span, uy * span]] };
}

/**
 * Screen space, in CSS pixels, that Excalidraw's toolbars cover at each edge
 * of the small whiteboard window, measured on DevSpace.app's window: the
 * tool bar at the top, the library and lock buttons at the right, and the
 * bottom bar.
 */
export const TOOLBAR_INSETS = { top: 64, right: 44, bottom: 72, left: 12 } as const;

export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Excalidraw's viewport: a board point p shows at screen (p + scroll) * zoom. */
export interface CanvasViewport {
  width: number;
  height: number;
  zoom: number;
  scrollX: number;
  scrollY: number;
}

export interface BoardPoint {
  x: number;
  y: number;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
const FIT_PADDING_PX = 12;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The board area the user can see between the toolbars. */
export function visibleArea(view: CanvasViewport, insets: ViewInsets = TOOLBAR_INSETS): WhiteboardBox {
  return {
    x: insets.left / view.zoom - view.scrollX,
    y: insets.top / view.zoom - view.scrollY,
    width: Math.max(1, view.width - insets.left - insets.right) / view.zoom,
    height: Math.max(1, view.height - insets.top - insets.bottom) / view.zoom,
  };
}

/** Scroll and zoom that put `center` in the middle of the area between the toolbars. */
export function centeredView(
  center: BoardPoint,
  zoom: number,
  view: CanvasViewport,
  insets: ViewInsets = TOOLBAR_INSETS,
): CanvasViewport {
  const value = clampZoom(zoom);
  const screenX = insets.left + Math.max(1, view.width - insets.left - insets.right) / 2;
  const screenY = insets.top + Math.max(1, view.height - insets.top - insets.bottom) / 2;

  return { ...view, zoom: value, scrollX: screenX / value - center.x, scrollY: screenY / value - center.y };
}

/** The largest zoom, up to `maxZoom`, at which `box` fits between the toolbars with some padding. */
export function fittingZoom(
  box: WhiteboardBox,
  view: CanvasViewport,
  maxZoom: number,
  insets: ViewInsets = TOOLBAR_INSETS,
): number {
  const width = Math.max(1, view.width - insets.left - insets.right - 2 * FIT_PADDING_PX);
  const height = Math.max(1, view.height - insets.top - insets.bottom - 2 * FIT_PADDING_PX);

  return clampZoom(Math.min(maxZoom, width / Math.max(box.width, 1), height / Math.max(box.height, 1)));
}

export function boxCenter(box: WhiteboardBox): BoardPoint {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function containsBox(outer: WhiteboardBox, inner: WhiteboardBox): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}
