import test from "node:test";
import assert from "node:assert/strict";
import {
  photoCanvasSize,
  validatePhoto,
  PHOTO_MAX_BYTES,
} from "../public/event-photo-frame.js";
test("local photo frame limits format, bytes and canvas size", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp"])
    validatePhoto({ type, size: PHOTO_MAX_BYTES });
  for (const type of ["image/svg+xml", "text/html", "image/gif", ""])
    assert.throws(() => validatePhoto({ type, size: 100 }));
  for (const size of [0, -1, PHOTO_MAX_BYTES + 1])
    assert.throws(() => validatePhoto({ type: "image/png", size }));
  for (const [w, h] of [
    [1, 1],
    [6000, 4000],
    [4000, 6000],
    [1000000, 1],
    [1, 1000000],
  ]) {
    const output = photoCanvasSize(w, h);
    assert(output.width <= 1600 && output.height <= 1600);
    assert(output.width > 0 && output.height > 0);
  }
  for (const x of [0, -1, NaN, Infinity])
    assert.throws(() => photoCanvasSize(x, 100));
});
