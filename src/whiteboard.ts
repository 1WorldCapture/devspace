import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logToolCall, textBlock } from "./tool-surfaces/shared.js";
import type { ToolContent } from "./tool-surfaces/types.js";
import { summarizeChanges, summarizeScene, type WhiteboardChanges } from "./whiteboard-scene.js";

/**
 * The desktop whiteboard: a floating Excalidraw window that DevSpace.app shows
 * on the user's Mac, which the host draws on and reads back through MCP tools.
 *
 * DevSpace.app starts the server with a random desktop token. The app
 * subscribes to `/desktop/events` to learn when to open or close the window,
 * and the canvas page in that window receives the host's commands over
 * `/desktop/whiteboard/api/stream` and answers them on `/api/result`. Requests
 * through the user's tunnel also arrive from loopback, so the token, not the
 * peer address, is what keeps these routes local to the app.
 *
 * There is at most one whiteboard. Closing it, from a tool or the window's
 * close button, discards its contents.
 */
export const DESKTOP_PATH = "/desktop";
export const DESKTOP_TOKEN_ENV = "DEVSPACE_DESKTOP_TOKEN";

export const WHITEBOARD_TOOL_NAMES = [
  "whiteboard_open",
  "whiteboard_update",
  "whiteboard_read",
  "whiteboard_view",
  "whiteboard_close",
] as const;

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 15_000;
const RESULT_BODY_LIMIT = "25mb";

const addElementSchema = z.object({
  type: z.enum(["rectangle", "ellipse", "diamond", "text", "arrow", "line"]),
  id: z.string().min(1).optional()
    .describe("Optional id to refer to this element later, for example as an arrow's from/to. Must be unique on the board."),
  x: z.number().optional().describe("Left edge in board units. Required except for arrows that use from/to."),
  y: z.number().optional().describe("Top edge in board units. Required except for arrows that use from/to."),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  text: z.string().optional()
    .describe("Text of a text element, or the label inside a shape or on an arrow."),
  from: z.string().optional().describe("Arrow only: id of the element the arrow starts from."),
  to: z.string().optional().describe("Arrow only: id of the element the arrow points to."),
  background_color: z.string().optional().describe("Fill color such as \"#ffec99\"; shapes only."),
  font_size: z.number().positive().optional(),
});

export const whiteboardOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), elements: z.array(addElementSchema).min(1) }),
  z.object({
    op: z.literal("update"),
    id: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    text: z.string().optional(),
    background_color: z.string().optional(),
  }),
  z.object({ op: z.literal("delete"), ids: z.array(z.string().min(1)).min(1) }),
  z.object({ op: z.literal("clear") }),
]);

export const whiteboardViewActionSchema = z.enum(["look", "fit", "focus", "zoom_in", "zoom_out", "pan"]);

export const panDirectionSchema = z.enum(["up", "down", "left", "right"]);

export type WhiteboardViewAction = z.infer<typeof whiteboardViewActionSchema>;

export type PanDirection = z.infer<typeof panDirectionSchema>;

export type WhiteboardAddElement = z.infer<typeof addElementSchema>;

export type WhiteboardOperation = z.infer<typeof whiteboardOperationSchema>;

/** A command the canvas page carries out and answers on `/api/result`. */
export type CanvasCommand =
  | { request_id: string; kind: "update"; operations: WhiteboardOperation[] }
  | { request_id: string; kind: "read"; include_image: boolean }
  | { request_id: string; kind: "view"; action: WhiteboardViewAction; ids?: string[]; direction?: PanDirection };

const sceneElementSchema = z.object({
  id: z.string(),
  type: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  version: z.number(),
  isDeleted: z.boolean(),
  strokeColor: z.string(),
  text: z.string().optional(),
  containerId: z.string().nullish(),
  startBinding: z.object({ elementId: z.string() }).nullish(),
  endBinding: z.object({ elementId: z.string() }).nullish(),
  customData: z.object({
    author: z.string().optional(),
    lastEditor: z.string().optional(),
  }).nullish(),
});

const canvasResultSchema = z.object({
  session: z.string(),
  request_id: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  elements: z.array(sceneElementSchema).optional(),
  /** Update only: ids of the elements the batch drew, edited, or deleted. */
  changed_ids: z.array(z.string()).optional(),
  image: z.string().optional(),
  view: z.object({
    zoom: z.number(),
    visible_area: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    window: z.object({ width: z.number(), height: z.number() }),
  }).optional(),
});

type CanvasResult = z.infer<typeof canvasResultSchema>;

export class WhiteboardError extends Error {}

interface PendingCommand {
  resolve: (result: CanvasResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WhiteboardSession {
  id: string;
  canvas?: Response;
  connected: Promise<void>;
  markConnected: () => void;
  pending: Map<string, PendingCommand>;
}

export interface WhiteboardManagerOptions {
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** Directory holding the built canvas page; defaults to dist/whiteboard. */
  buildDirectory?: string;
}

export type WhiteboardView = NonNullable<CanvasResult["view"]>;

export interface WhiteboardSnapshot {
  elements: ReturnType<typeof summarizeScene>;
  /** What the window shows: zoom, the board area visible between the toolbars, and the window size. */
  view?: WhiteboardView;
  image?: string;
}

/** What one whiteboard_update changed, and what the window shows afterwards. */
export interface WhiteboardUpdate extends WhiteboardChanges {
  view?: WhiteboardView;
}

export class WhiteboardManager {
  private readonly tokenDigest: Buffer;
  private readonly desktopClients = new Set<Response>();
  private session: WhiteboardSession | undefined;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly buildDirectory: string;

  constructor(private readonly token: string, options: WhiteboardManagerOptions = {}) {
    this.tokenDigest = digest(token);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.buildDirectory = options.buildDirectory
      ?? fileURLToPath(new URL("../dist/whiteboard", import.meta.url));
  }

  get isOpen(): boolean {
    return this.session?.canvas !== undefined;
  }

  /** Opens the whiteboard window, or returns at once when it is already open. */
  async open(): Promise<{ alreadyOpen: boolean }> {
    if (this.session?.canvas) return { alreadyOpen: true };

    if (!this.session) {
      if (this.desktopClients.size === 0) {
        throw new WhiteboardError(
          "DevSpace.app is not connected. The whiteboard needs the DevSpace menu bar app running on the user's Mac.",
        );
      }

      this.session = createSession();
      this.broadcast({ type: "whiteboard.open", path: `${DESKTOP_PATH}/whiteboard/#session=${this.session.id}&token=${this.token}` });
    }

    const session = this.session;
    let timer: NodeJS.Timeout | undefined;

    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new WhiteboardError("The whiteboard window did not open in time.")), this.connectTimeoutMs);
    });

    try {
      await Promise.race([session.connected, timedOut]);
    } catch (error) {
      if (this.session === session) this.destroy("The whiteboard window did not open in time.");

      throw error;
    } finally {
      clearTimeout(timer);
    }

    return { alreadyOpen: false };
  }

  async update(operations: WhiteboardOperation[]): Promise<WhiteboardUpdate> {
    const result = await this.command({ request_id: randomUUID(), kind: "update", operations });
    const value: WhiteboardUpdate = summarizeChanges(result.elements ?? [], result.changed_ids ?? []);

    if (result.view) value.view = result.view;

    return value;
  }

  async read(includeImage: boolean): Promise<WhiteboardSnapshot> {
    return snapshot(await this.command({ request_id: randomUUID(), kind: "read", include_image: includeImage }));
  }

  /** Moves the window's view, then captures what the window shows. */
  async view(action: WhiteboardViewAction, ids?: string[], direction?: PanDirection): Promise<WhiteboardSnapshot> {
    const command: CanvasCommand = { request_id: randomUUID(), kind: "view", action };

    if (ids) command.ids = ids;

    if (direction) command.direction = direction;

    return snapshot(await this.command(command));
  }

  /** Closes the window and discards the board. Returns false when nothing was open. */
  close(): boolean {
    if (!this.session) return false;

    this.destroy("The whiteboard was closed.");

    return true;
  }

  shutdown(): void {
    this.destroy("DevSpace is shutting down.");

    for (const client of this.desktopClients) client.end();

    this.desktopClients.clear();
  }

  router(): Router {
    const router = express.Router();
    const requireToken = (req: Request, res: Response, next: NextFunction) => this.requireToken(req, res, next);

    router.get("/events", requireToken, (req, res) => {
      openEventStream(res);
      this.desktopClients.add(res);

      req.on("close", () => {
        this.desktopClients.delete(res);
      });
    });

    router.get("/whiteboard/api/stream", requireToken, (req, res) => {
      const session = this.session;

      if (!session || req.query.session !== session.id) {
        res.status(404).json({ error: "This whiteboard is no longer open." });

        return;
      }

      if (session.canvas) {
        res.status(409).json({ error: "The whiteboard is already connected." });

        return;
      }

      openEventStream(res);
      session.canvas = res;
      session.markConnected();

      req.on("close", () => {
        if (this.session === session && session.canvas === res) {
          this.destroy("The user closed the whiteboard.");
        }
      });
    });

    router.post(
      "/whiteboard/api/result",
      requireToken,
      express.text({ type: "text/plain", limit: RESULT_BODY_LIMIT }),
      (req, res) => {
        let result: CanvasResult;

        try {
          result = canvasResultSchema.parse(JSON.parse(String(req.body)));
        } catch {
          res.status(400).json({ error: "Invalid result." });

          return;
        }

        const pending = this.session?.id === result.session
          ? this.session.pending.get(result.request_id)
          : undefined;

        if (!pending) {
          res.status(404).json({ error: "No command is waiting for this result." });

          return;
        }

        this.session?.pending.delete(result.request_id);
        clearTimeout(pending.timer);
        pending.resolve(result);
        res.status(204).end();
      },
    );

    // The page and its assets hold no secrets; the token arrives in the URL
    // fragment, which browsers never send to the server.
    router.use("/whiteboard", express.static(this.buildDirectory, { fallthrough: false }));

    return router;
  }

  private requireToken(req: Request, res: Response, next: NextFunction): void {
    const header = req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

    if (presented && timingSafeEqual(digest(presented), this.tokenDigest)) {
      next();

      return;
    }

    res.status(401).json({ error: "Unauthorized" });
  }

  private async command(command: CanvasCommand): Promise<CanvasResult> {
    const session = this.session;
    const canvas = session?.canvas;

    if (!session || !canvas) {
      throw new WhiteboardError("The whiteboard is not open. Call whiteboard_open first.");
    }

    const result = await new Promise<CanvasResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(command.request_id);
        reject(new WhiteboardError("The whiteboard did not respond in time."));
      }, this.commandTimeoutMs);

      session.pending.set(command.request_id, { resolve, reject, timer });
      writeEvent(canvas, command);
    });

    if (!result.ok) throw new WhiteboardError(result.error ?? "The whiteboard rejected the change.");

    return result;
  }

  private destroy(reason: string): void {
    const session = this.session;

    if (!session) return;

    this.session = undefined;

    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new WhiteboardError(reason));
    }

    session.pending.clear();
    session.canvas?.end();
    this.broadcast({ type: "whiteboard.close" });
  }

  private broadcast(event: WhiteboardDesktopEvent): void {
    for (const client of this.desktopClients) writeEvent(client, event);
  }
}

type WhiteboardDesktopEvent =
  | { type: "whiteboard.open"; path: string }
  | { type: "whiteboard.close" };

function createSession(): WhiteboardSession {
  let markConnected = () => {};
  const connected = new Promise<void>((resolve) => { markConnected = resolve; });

  return { id: randomUUID(), connected, markConnected, pending: new Map() };
}

function snapshot(result: CanvasResult): WhiteboardSnapshot {
  const value: WhiteboardSnapshot = { elements: summarizeScene(result.elements ?? []) };

  if (result.view) value.view = result.view;

  if (result.image) value.image = result.image;

  return value;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function openEventStream(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);

  res.on("close", () => clearInterval(heartbeat));
}

function writeEvent(res: Response, event: CanvasCommand | WhiteboardDesktopEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

const BOARD_GUIDE = "Elements report author (\"assistant\" for yours, \"user\" for the user's) and last_editor. "
  + "Each author draws in a fixed color, so do not try to set stroke colors.";

export function registerWhiteboardTools(
  server: Pick<McpServer, "registerTool">,
  config: ServerConfig,
  whiteboard: WhiteboardManager,
): void {
  const annotations = { destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "whiteboard_open",
    {
      title: "Open whiteboard",
      description:
        "Open a shared Excalidraw whiteboard in a small floating window on the user's Mac, for sketching ideas while talking. "
        + "Both you and the user can draw on it. Does nothing if it is already open. Not tied to any workspace.",
      inputSchema: {},
      annotations: { ...annotations, readOnlyHint: false, idempotentHint: true },
    },
    () => runWhiteboardTool(config, "whiteboard_open", async () => {
      const { alreadyOpen } = await whiteboard.open();

      return [textBlock(alreadyOpen ? "The whiteboard is already open." : "The whiteboard is open on the user's screen.")];
    }),
  );

  server.registerTool(
    "whiteboard_update",
    {
      title: "Draw on whiteboard",
      description:
        "Add, update, or delete elements on the open whiteboard in one batch; all operations apply or none do. "
        + "Use labeled shapes for ideas and arrows with from/to ids to connect them; the board keeps the content in view, "
        + "so lay elements out on a roomy grid (for example 200x80 boxes, 80 units apart). "
        + "The user sees nothing until a call arrives, so build a diagram over several calls of about 3 to 6 elements each, "
        + "for example the main shapes first, then the arrows between them, then notes and colors; "
        + "the window draws each batch's elements one after another. "
        + "The window brings changed elements into view when they are off screen and otherwise leaves the user's view alone. "
        + `${BOARD_GUIDE} Returns the elements this call changed, the ids it deleted, element_count, `
        + "and view.visible_area, the board area the user sees; use whiteboard_read for the whole board, "
        + "and check the result with whiteboard_view after larger changes.",
      inputSchema: { operations: z.array(whiteboardOperationSchema).min(1) },
      annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
    },
    ({ operations }) => runWhiteboardTool(config, "whiteboard_update", async () => {
      const board = await whiteboard.update(operations);

      return [textBlock(JSON.stringify(board))];
    }),
  );

  server.registerTool(
    "whiteboard_read",
    {
      title: "Read whiteboard",
      description:
        "Read every element on the open whiteboard, including what the user drew. "
        + `${BOARD_GUIDE} Set include_image to also get a picture of the whole board regardless of the window's view, `
        + "for freehand drawings that text cannot describe. To see what the user actually sees, use whiteboard_view.",
      inputSchema: { include_image: z.boolean().optional() },
      annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
    },
    ({ include_image: includeImage }) => runWhiteboardTool(config, "whiteboard_read", async () => {
      const { image, ...board } = await whiteboard.read(includeImage === true);
      const content: ToolContent[] = [textBlock(JSON.stringify(board))];

      if (image) content.push({ type: "image", data: image, mimeType: "image/png" });

      return content;
    }),
  );

  server.registerTool(
    "whiteboard_view",
    {
      title: "View whiteboard",
      description:
        "Adjust what the whiteboard window shows and return a screenshot of the window exactly as the user sees it, "
        + "toolbars included, with view (zoom, visible_area in board units, window size in pixels). "
        + "Actions: look (no change), fit (show the whole board), focus (show the elements in ids), "
        + "zoom_in, zoom_out, and pan (move half a window in direction). "
        + "Use it to check that a drawing is readable at the window's real size before describing it to the user.",
      inputSchema: {
        action: whiteboardViewActionSchema,
        ids: z.array(z.string().min(1)).min(1).optional().describe("focus only: elements to bring into view."),
        direction: panDirectionSchema.optional().describe("pan only: which way to move the view."),
      },
      annotations: { ...annotations, readOnlyHint: false, idempotentHint: false },
    },
    ({ action, ids, direction }) => runWhiteboardTool(config, "whiteboard_view", async () => {
      if (action === "focus" && !ids) throw new WhiteboardError("focus needs ids.");

      if (action === "pan" && !direction) throw new WhiteboardError("pan needs a direction.");

      const { image, ...board } = await whiteboard.view(action, ids, direction);
      const content: ToolContent[] = [textBlock(JSON.stringify(board.view ?? {}))];

      if (image) content.push({ type: "image", data: image, mimeType: "image/png" });

      return content;
    }),
  );

  server.registerTool(
    "whiteboard_close",
    {
      title: "Close whiteboard",
      description: "Close the whiteboard window. Its contents are discarded.",
      inputSchema: {},
      annotations: { ...annotations, readOnlyHint: false, idempotentHint: true, destructiveHint: true },
    },
    () => runWhiteboardTool(config, "whiteboard_close", async () => [
      textBlock(whiteboard.close() ? "The whiteboard is closed and its contents were discarded." : "No whiteboard was open."),
    ]),
  );
}

async function runWhiteboardTool(
  config: ServerConfig,
  tool: string,
  operation: () => Promise<ToolContent[]>,
): Promise<{ content: ToolContent[]; isError?: boolean }> {
  const startedAt = performance.now();

  try {
    const content = await operation();
    logToolCall(config, { tool, success: true, durationMs: Math.round(performance.now() - startedAt) });

    return { content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logToolCall(config, { tool, success: false, durationMs: Math.round(performance.now() - startedAt), error: message });

    return { content: [textBlock(message)], isError: true };
  }
}
