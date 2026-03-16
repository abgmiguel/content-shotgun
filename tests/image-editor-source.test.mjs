import test from "node:test";
import assert from "node:assert/strict";

const {
  inferImageMimeType,
  bytesToBase64,
  bytesToDataUrl
} = await import("../.tmp-tests/imageEditorSource.js");

test("inferImageMimeType resolves common extensions", () => {
  assert.equal(inferImageMimeType("/tmp/hero.png"), "image/png");
  assert.equal(inferImageMimeType("/tmp/photo.jpg"), "image/jpeg");
  assert.equal(inferImageMimeType("/tmp/photo.jpeg"), "image/jpeg");
  assert.equal(inferImageMimeType("/tmp/vector.svg"), "image/svg+xml");
  assert.equal(inferImageMimeType("/tmp/icon.avif"), "image/avif");
});

test("inferImageMimeType falls back safely for unknown or missing extension", () => {
  assert.equal(inferImageMimeType("/tmp/file.unknown"), "image/png");
  assert.equal(inferImageMimeType("/tmp/noext"), "image/png");
  assert.equal(inferImageMimeType("/tmp/image.webp?v=1#x"), "image/webp");
});

test("bytesToBase64 and bytesToDataUrl produce stable data URLs", () => {
  const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  const b64 = bytesToBase64(bytes);
  assert.equal(b64, "SGVsbG8=");
  assert.equal(bytesToDataUrl(bytes, "image/png"), "data:image/png;base64,SGVsbG8=");
});
