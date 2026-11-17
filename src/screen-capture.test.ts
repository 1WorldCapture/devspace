import assert from "node:assert/strict";
import { test } from "node:test";
import { activeDisplayRegion, isScreenCaptureSupportedPlatform } from "./screen-capture.js";

const builtIn = { name: "Built-in", x: 0, y: 0, width: 1512, height: 982 };
const external = { name: "External", x: -231, y: 982, width: 1920, height: 1080 };

test("selects the display under the cursor and converts to top-left global coordinates", () => {
  const region = activeDisplayRegion({
    cursor: { x: 1005, y: 1310 },
    displays: [builtIn, external],
    screenCaptureAllowed: true,
  });

  assert.deepEqual(region, { name: "External", x: -231, y: -1080, width: 1920, height: 1080 });
});

test("selects the primary display when the cursor is on it", () => {
  const region = activeDisplayRegion({
    cursor: { x: 100, y: 100 },
    displays: [builtIn, external],
    screenCaptureAllowed: true,
  });

  assert.deepEqual(region, { name: "Built-in", x: 0, y: 0, width: 1512, height: 982 });
});

test("falls back to the primary display when the cursor is outside every display", () => {
  const region = activeDisplayRegion({
    cursor: { x: 99_999, y: 99_999 },
    displays: [builtIn, external],
    screenCaptureAllowed: true,
  });

  assert.equal(region.name, "Built-in");
});

test("rejects a probe without displays", () => {
  assert.throws(() => activeDisplayRegion({
    cursor: { x: 0, y: 0 },
    displays: [],
    screenCaptureAllowed: true,
  }));
});

test("supports macOS only", () => {
  assert.equal(isScreenCaptureSupportedPlatform("darwin"), true);
  assert.equal(isScreenCaptureSupportedPlatform("linux"), false);
  assert.equal(isScreenCaptureSupportedPlatform("win32"), false);
});
