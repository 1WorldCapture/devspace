import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import type { ServerConfig } from "./config.js";
import { unsafeNarrow } from "./unsafe-narrow.js";
import { registerWhiteboardTools, WHITEBOARD_TOOL_NAMES, WhiteboardManager } from "./whiteboard.js";
import {
  arrowBetween,
  AUTHOR_STROKE_COLORS,
  boxCenter,
  centeredView,
  fittingZoom,
  summarizeChanges,
  summarizeScene,
  visibleArea,
  userEditPatches,
  type WhiteboardElement,
} from "./whiteboard-scene.js";

const TOKEN = "desktop-token";

function element(id: string, overrides: Partial<WhiteboardElement> = {}): WhiteboardElement {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    version: 1,
    isDeleted: false,
    strokeColor: AUTHOR_STROKE_COLORS.assistant,
    customData: { author: "assistant", lastEditor: "assistant" },
    ...overrides,
  };
}

test("user edits keep the original author and color but change the last editor", () => {
  const moved = element("box", { version: 3, x: 40 });
  const recolored = element("other", { version: 2, strokeColor: "#2f9e44" });
  const untouched = element("same", { version: 5 });
  const seen = new Map([["box", 2], ["other", 1], ["same", 5]]);

  assert.deepEqual(userEditPatches([moved, recolored, untouched], seen), [
    { id: "box", author: "assistant", lastEditor: "user", strokeColor: AUTHOR_STROKE_COLORS.assistant },
    { id: "other", author: "assistant", lastEditor: "user", strokeColor: AUTHOR_STROKE_COLORS.assistant },
  ]);
});

test("elements the board never attributed belong to the user, even when pasted with assistant authorship", () => {
  const drawn = element("drawn", { strokeColor: "#1e1e1e", customData: null });
  const pasted = element("pasted");
  const userOwn = element("mine", { version: 4, strokeColor: AUTHOR_STROKE_COLORS.user, customData: { author: "user", lastEditor: "user" } });

  assert.deepEqual(userEditPatches([drawn, pasted, userOwn], new Map([["mine", 3]])), [
    { id: "drawn", author: "user", lastEditor: "user", strokeColor: AUTHOR_STROKE_COLORS.user },
    { id: "pasted", author: "user", lastEditor: "user", strokeColor: AUTHOR_STROKE_COLORS.user },
  ]);
});

test("scene summaries fold labels into their container and report arrow ends", () => {
  const summary = summarizeScene([
    element("a", { x: 10.4, y: 20.6 }),
    element("a-label", { type: "text", text: "Idea", containerId: "a" }),
    element("b", { customData: { author: "user", lastEditor: "assistant" } }),
    element("arrow", { type: "arrow", startBinding: { elementId: "a" }, endBinding: { elementId: "b" } }),
    element("gone", { isDeleted: true }),
  ]);

  assert.deepEqual(summary.map(({ id, text, from, to, author, last_editor }) => ({ id, text, from, to, author, last_editor })), [
    { id: "a", text: "Idea", from: undefined, to: undefined, author: "assistant", last_editor: "assistant" },
    { id: "b", text: undefined, from: undefined, to: undefined, author: "user", last_editor: "assistant" },
    { id: "arrow", text: undefined, from: "a", to: "b", author: "assistant", last_editor: "assistant" },
  ]);
  assert.deepEqual([summary[0]?.x, summary[0]?.y], [10, 21]);
});

test("update results describe only what the batch changed", () => {
  const changes = summarizeChanges([
    element("kept"),
    element("relabeled"),
    element("relabeled-label", { type: "text", text: "New", containerId: "relabeled" }),
    element("added", { type: "ellipse" }),
    element("removed", { isDeleted: true }),
    element("removed-label", { type: "text", text: "Old", containerId: "removed", isDeleted: true }),
  ], ["relabeled-label", "added", "removed", "removed-label", "unknown"]);

  assert.deepEqual(changes.changed.map(({ id, text }) => ({ id, text })), [
    { id: "relabeled", text: "New" },
    { id: "added", text: undefined },
  ]);
  assert.deepEqual(changes.deleted, ["removed"]);
  assert.equal(changes.element_count, 3);
});

test("arrows run from edge to edge between boxes", () => {
  const placement = arrowBetween({ x: 0, y: 0, width: 100, height: 40 }, { x: 300, y: 0, width: 50, height: 40 });

  assert.deepEqual(placement, { x: 108, y: 20, points: [[0, 0], [184, 0]] });
});

test("the visible area excludes the toolbars and follows Excalidraw's scroll and zoom", () => {
  const view = { width: 800, height: 600, zoom: 2, scrollX: -100, scrollY: 50 };

  // Insets are 12 left, 64 top, 44 right, 72 bottom screen pixels.
  assert.deepEqual(visibleArea(view), { x: 106, y: -18, width: 372, height: 232 });

  const centered = centeredView({ x: 500, y: 300 }, 0.5, view);

  assert.equal(centered.zoom, 0.5);
  assert.deepEqual(boxCenter(visibleArea(centered)), { x: 500, y: 300 });
  // A wide box is limited by the width left between the toolbars, minus padding.
  assert.equal(fittingZoom({ x: 0, y: 0, width: 1000, height: 100 }, view, 1), 0.72);
  assert.equal(fittingZoom({ x: 0, y: 0, width: 10, height: 10 }, view, 1.5), 1.5);
});

interface EventReader {
  next(): Promise<string>;
}

async function eventStream(url: string, token = TOKEN): Promise<EventReader & { response: Response; close(): void }> {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  return {
    response,
    close: () => controller.abort(),
    async next() {
      for (;;) {
        const match = buffer.match(/^data: (.*)$/m);

        if (match) {
          buffer = buffer.slice(buffer.indexOf(match[0]) + match[0].length);

          return match[1]!;
        }

        const { value, done } = await reader.read();

        if (done) throw new Error("stream ended");

        buffer += value;
      }
    },
  };
}

async function startDesktop(t: TestContext) {
  const whiteboard = new WhiteboardManager(TOKEN, { connectTimeoutMs: 2_000, commandTimeoutMs: 2_000 });
  const app = express();
  app.use("/desktop", whiteboard.router());

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  // SAFETY: A TCP listener reports an AddressInfo.
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/desktop`;

  t.after(() => {
    whiteboard.shutdown();
    server.closeAllConnections();
    server.close();
  });

  return { whiteboard, base };
}

test("desktop routes require the desktop token", async (t) => {
  const { base } = await startDesktop(t);

  for (const headers of [new Headers(), new Headers({ Authorization: "Bearer wrong" })]) {
    assert.equal((await fetch(`${base}/events`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/whiteboard/api/stream?session=x`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/whiteboard/api/result`, { method: "POST", headers, body: "{}" })).status, 401);
  }
});

test("opening without DevSpace.app connected fails clearly", async (t) => {
  const { whiteboard } = await startDesktop(t);

  await assert.rejects(whiteboard.open(), /DevSpace\.app is not connected/);
});

test("the board opens through the app, answers reads from the canvas, and is discarded when the window closes", async (t) => {
  const { whiteboard, base } = await startDesktop(t);
  const desktop = await eventStream(`${base}/events`);
  const opening = whiteboard.open();
  const openEvent = JSON.parse(await desktop.next());

  assert.equal(openEvent.type, "whiteboard.open");

  const fragment = new URLSearchParams(openEvent.path.split("#")[1]);
  assert.equal(fragment.get("token"), TOKEN);

  const session = fragment.get("session")!;
  const canvas = await eventStream(`${base}/whiteboard/api/stream?session=${session}`);
  assert.deepEqual(await opening, { alreadyOpen: false });
  assert.deepEqual(await whiteboard.open(), { alreadyOpen: true });

  // A second window for the same board is refused.
  assert.equal((await fetch(`${base}/whiteboard/api/stream?session=${session}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).status, 409);

  const reading = whiteboard.read(false);
  const command = JSON.parse(await canvas.next());
  assert.deepEqual({ kind: command.kind, include_image: command.include_image }, { kind: "read", include_image: false });

  const posted = await fetch(`${base}/whiteboard/api/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
    body: JSON.stringify({
      session,
      request_id: command.request_id,
      ok: true,
      elements: [{ ...element("sketch", { type: "freedraw", customData: { author: "user", lastEditor: "user" } }), points: [[0, 0]] }],
    }),
  });

  assert.equal(posted.status, 204);
  assert.deepEqual((await reading).elements.map(({ id, author }) => ({ id, author })), [{ id: "sketch", author: "user" }]);

  const failing = assert.rejects(whiteboard.update([{ op: "delete", ids: ["missing"] }]), /No element with id "missing"/);
  const update = JSON.parse(await canvas.next());

  await fetch(`${base}/whiteboard/api/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
    body: JSON.stringify({ session, request_id: update.request_id, ok: false, error: "No element with id \"missing\" on the board." }),
  });

  await failing;

  // The user closes the window: the canvas stream drops and the board is gone.
  canvas.close();
  assert.deepEqual(JSON.parse(await desktop.next()), { type: "whiteboard.close" });
  await assert.rejects(whiteboard.read(false), /not open/);
  assert.equal(whiteboard.close(), false);
  desktop.close();
});

test("whiteboard tools are listed and report a missing app as a tool error", async (t) => {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const whiteboard = new WhiteboardManager(TOKEN);
  registerWhiteboardTools(server, unsafeNarrow<ServerConfig>({ logging: { toolCalls: false } }), whiteboard);

  const client = new Client({ name: "client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...WHITEBOARD_TOOL_NAMES].sort());

  const opened = await client.callTool({ name: "whiteboard_open", arguments: {} });
  assert.equal(opened.isError, true);

  const update = await client.callTool({ name: "whiteboard_update", arguments: { operations: [{ op: "clear" }] } });
  assert.equal(update.isError, true);
  assert.match(JSON.stringify(update.content), /not open/);
});
