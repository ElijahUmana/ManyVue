import assert from "node:assert/strict";
import test from "node:test";
import { signMediaKey, signedMediaUrl, verifyMediaKey } from "./media-url";

const secret = "manyvue-test-secret-that-is-at-least-thirty-two-characters";

test("media signatures are bound to the exact object key and expiry", async () => {
  const expires = 2_000_000_000;
  const signature = await signMediaKey("session/camera/clip.webm", expires, secret);
  assert.equal(await verifyMediaKey("session/camera/clip.webm", expires, signature, secret, expires - 10), true);
  assert.equal(await verifyMediaKey("session/camera/other.webm", expires, signature, secret, expires - 10), false);
  assert.equal(await verifyMediaKey("session/camera/clip.webm", expires, signature, secret, expires + 1), false);
});

test("signed media URLs contain no participant or host capability", async () => {
  const url = new URL(await signedMediaUrl("https://manyvue.example", "room/camera/burst.webm", secret));
  assert.equal(url.pathname, "/api/uploads");
  assert.equal(url.searchParams.get("key"), "room/camera/burst.webm");
  assert.ok(url.searchParams.get("expires"));
  assert.ok(url.searchParams.get("signature"));
  assert.equal(url.searchParams.has("participantCapability"), false);
  assert.equal(url.searchParams.has("hostCapability"), false);
});
