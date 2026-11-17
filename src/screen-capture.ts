import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { logToolCall, textBlock } from "./tool-surfaces/shared.js";
import type { ToolContent } from "./tool-surfaces/types.js";

const execFileAsync = promisify(execFile);

export const CAPTURE_SCREEN_TOOL_NAME = "capture_screen";

const MAX_IMAGE_EDGE_PX = 1600;
const JPEG_QUALITY = 70;
const COMMAND_TIMEOUT_MS = 15_000;

// JXA: report the cursor position, every display frame, and whether this
// process tree is allowed to record the screen. AppKit frames use a
// bottom-left origin anchored to the primary (menu bar) display.
const PROBE_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
const mouse = $.NSEvent.mouseLocation;
const screens = $.NSScreen.screens;
const displays = [];
for (let i = 0; i < screens.count; i++) {
  const screen = screens.objectAtIndex(i);
  const frame = screen.frame;
  displays.push({
    name: ObjC.unwrap(screen.localizedName),
    x: frame.origin.x,
    y: frame.origin.y,
    width: frame.size.width,
    height: frame.size.height,
  });
}
JSON.stringify({
  cursor: { x: mouse.x, y: mouse.y },
  displays,
  screenCaptureAllowed: $.CGPreflightScreenCaptureAccess(),
});
`;

// Asking registers the responsible app (the terminal running DevSpace) in
// System Settings > Privacy & Security > Screen Recording.
const REQUEST_ACCESS_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);
$.CGRequestScreenCaptureAccess();
`;

const screenProbeSchema = z.object({
  cursor: z.object({ x: z.number(), y: z.number() }),
  displays: z.array(z.object({
    name: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })),
  screenCaptureAllowed: z.boolean(),
});

type ScreenProbe = z.infer<typeof screenProbeSchema>;

/** Region in global display coordinates with a top-left origin, as screencapture -R expects. */
export interface CaptureRegion {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isScreenCaptureSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "darwin";
}

/**
 * Picks the display containing the cursor and converts its AppKit frame into
 * top-left-origin global coordinates. Falls back to the primary display.
 */
export function activeDisplayRegion(probe: ScreenProbe): CaptureRegion {
  const primary = probe.displays[0];

  if (!primary) throw new Error("No display is available to capture.");

  const { x, y } = probe.cursor;

  const active = probe.displays.find((display) =>
    x >= display.x
    && x < display.x + display.width
    && y >= display.y
    && y < display.y + display.height,
  ) ?? primary;

  return {
    name: active.name,
    x: Math.round(active.x),
    y: Math.round(primary.height - (active.y + active.height)),
    width: Math.round(active.width),
    height: Math.round(active.height),
  };
}

async function runJxa(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script],
    { timeout: COMMAND_TIMEOUT_MS },
  );

  return stdout.trim();
}

export interface ScreenCapture {
  display: string;
  data: string;
  mimeType: "image/jpeg";
}

export async function captureActiveDisplay(): Promise<ScreenCapture> {
  const probe = screenProbeSchema.parse(JSON.parse(await runJxa(PROBE_SCRIPT)));

  if (!probe.screenCaptureAllowed) {
    await runJxa(REQUEST_ACCESS_SCRIPT).catch(() => undefined);
    throw new Error(
      "Screen Recording permission is not granted to the app running DevSpace. "
      + "The user must enable it for their terminal app in System Settings > Privacy & Security > Screen Recording, "
      + "then restart that terminal app and DevSpace.",
    );
  }

  const region = activeDisplayRegion(probe);
  const directory = await mkdtemp(join(tmpdir(), "devspace-screen-"));
  const pngPath = join(directory, "capture.png");
  const jpegPath = join(directory, "capture.jpg");

  try {
    await execFileAsync(
      "/usr/sbin/screencapture",
      ["-x", "-t", "png", `-R${region.x},${region.y},${region.width},${region.height}`, pngPath],
      { timeout: COMMAND_TIMEOUT_MS },
    );
    await execFileAsync(
      "/usr/bin/sips",
      [
        "-Z", String(MAX_IMAGE_EDGE_PX),
        "-s", "format", "jpeg",
        "-s", "formatOptions", String(JPEG_QUALITY),
        pngPath,
        "--out", jpegPath,
      ],
      { timeout: COMMAND_TIMEOUT_MS },
    );

    const data = (await readFile(jpegPath)).toString("base64");

    return { display: region.name, data, mimeType: "image/jpeg" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function registerScreenCaptureTool(
  server: Pick<McpServer, "registerTool">,
  config: ServerConfig,
): void {
  server.registerTool(
    CAPTURE_SCREEN_TOOL_NAME,
    {
      title: "Capture screen",
      description:
        "Capture a screenshot of the user's current display (the one under the mouse cursor) on their local machine. "
        + "Use when the user refers to something visible on their screen. Not tied to any workspace.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const startedAt = performance.now();

      try {
        const capture = await captureActiveDisplay();

        const content: ToolContent[] = [
          textBlock(`Screenshot of display "${capture.display}".`),
          { type: "image", data: capture.data, mimeType: capture.mimeType },
        ];

        logToolCall(config, {
          tool: CAPTURE_SCREEN_TOOL_NAME,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return { content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logToolCall(config, {
          tool: CAPTURE_SCREEN_TOOL_NAME,
          success: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: message,
        });

        return { content: [textBlock(`Screen capture failed: ${message}`)], isError: true };
      }
    },
  );
}
