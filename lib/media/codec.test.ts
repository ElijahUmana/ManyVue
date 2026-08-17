import assert from "node:assert/strict";
import test from "node:test";
import { mediaRecorderOptions } from "./codec";

test("video-only recorders omit an invalid zero audio bitrate", () => {
  const options = mediaRecorderOptions({
    mimeType: "video/webm",
    extension: "webm",
    explicitlySupported: true,
  }, 520_000, 0);
  assert.equal(options.videoBitsPerSecond, 520_000);
  assert.equal("audioBitsPerSecond" in options, false);
});
