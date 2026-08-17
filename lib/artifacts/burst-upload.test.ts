import assert from "node:assert/strict";
import test from "node:test";
import { BurstUploadError, burstEditCandidates, listBurstAssets, uploadBurstCaptureAssets } from "./burst-upload";

test("uploads a four-second Burst clip before its optional contact sheet with stable IDs", async () => {
  const requests: { kind: string; clientAssetId: string; capability: string | null }[] = [];
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const form = init?.body as FormData;
    const kind = String(form.get("kind"));
    const clientAssetId = String(form.get("clientAssetId"));
    requests.push({
      kind,
      clientAssetId,
      capability: new Headers(init?.headers).get("x-manyvue-participant-capability"),
    });
    return Response.json({
      ok: true,
      key: `room/camera/${kind}-${clientAssetId}`,
      url: `https://manyvue.test/api/uploads?key=${kind}-${clientAssetId}`,
      duplicate: false,
    });
  }) as typeof fetch;

  const result = await uploadBurstCaptureAssets({
    session: "room",
    participant: "camera",
    access: { role: "participant", participantId: "camera", participantCapability: "participant-secret" },
    burstId: "burst-12345678",
    clip: new Blob(["clip"], { type: "video/mp4" }),
    thumbnail: new Blob(["frame"], { type: "image/jpeg" }),
    durationMs: 4_000,
    burstOffsetMs: 1_500,
  }, fakeFetch);

  assert.equal(result.thumbnailWarning, null);
  assert.deepEqual(requests.map((request) => request.kind), ["burst-source", "thumbnail"]);
  assert.equal(requests[0].clientAssetId, "burst-burst-12345678-camera-clip");
  assert.equal(requests[1].clientAssetId, "burst-burst-12345678-camera-contact-sheet");
  assert.deepEqual(requests.map((request) => request.capability), ["participant-secret", "participant-secret"]);
});

test("keeps a successfully uploaded Burst clip when optional thumbnail upload fails", async () => {
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const kind = String((init?.body as FormData).get("kind"));
    if (kind === "thumbnail") return Response.json({ ok: false, error: "decode unavailable" }, { status: 503 });
    return Response.json({ ok: true, key: "clip", url: "https://manyvue.test/clip", duplicate: false });
  }) as typeof fetch;

  const result = await uploadBurstCaptureAssets({
    session: "room",
    participant: "camera",
    access: { role: "participant", participantId: "camera", participantCapability: "participant-secret" },
    burstId: "burst-12345678",
    clip: new Blob(["clip"], { type: "video/mp4" }),
    thumbnail: new Blob(["frame"], { type: "image/jpeg" }),
    durationMs: 4_000,
    burstOffsetMs: 1_500,
  }, fakeFetch);

  assert.equal(result.clip.url, "https://manyvue.test/clip");
  assert.equal(result.thumbnail, null);
  assert.match(result.thumbnailWarning ?? "", /clip is uploaded/i);
});

test("fails before network ingress when a Burst violates the deployed body ceiling", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return Response.json({ ok: true });
  }) as typeof fetch;
  await assert.rejects(
    uploadBurstCaptureAssets({
      session: "room",
      participant: "camera",
      access: { role: "participant", participantId: "camera", participantCapability: "participant-secret" },
      burstId: "burst-12345678",
      clip: new Blob([new Uint8Array(1_800_001)], { type: "video/mp4" }),
      durationMs: 4_000,
      burstOffsetMs: 1_500,
    }, fakeFetch),
    (error: unknown) => error instanceof BurstUploadError && error.stage === "clip-upload",
  );
  assert.equal(called, false);
});

test("host mirror uploads use host authority while preserving the phone identity", async () => {
  let headers = new Headers();
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    return Response.json({ ok: true, key: "clip", url: "https://manyvue.test/clip", duplicate: false });
  }) as typeof fetch;

  await uploadBurstCaptureAssets({
    session: "room",
    participant: "phone-camera",
    access: { role: "host", sessionId: "session-id", hostCapability: "host-secret" },
    burstId: "burst-12345678",
    clip: new Blob(["clip"], { type: "video/mp4" }),
    durationMs: 9_000,
    burstOffsetMs: 4_500,
  }, fakeFetch);

  assert.equal(headers.get("x-manyvue-media-role"), "host");
  assert.equal(headers.get("x-manyvue-session-id"), "session-id");
  assert.equal(headers.get("x-manyvue-host-capability"), "host-secret");
  assert.equal(headers.get("x-manyvue-participant-id"), "phone-camera");
});

test("lists only the requested Burst through the exact server filter", async () => {
  let requested = "";
  let capability = "";
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input);
    capability = new Headers(init?.headers).get("x-manyvue-participant-capability") ?? "";
    return Response.json({ ok: true, assets: [] });
  }) as typeof fetch;
  assert.deepEqual(await listBurstAssets("room one", "burst/one", {
    role: "participant",
    participantId: "camera",
    participantCapability: "participant-secret",
  }, fakeFetch), []);
  assert.match(requested, /list=1/);
  assert.match(requested, /session=room\+one/);
  assert.match(requested, /burstId=burst%2Fone/);
  assert.equal(capability, "participant-secret");
});

test("builds a valid edit source even when Safari omitted the optional contact sheet", () => {
  const candidates = burstEditCandidates([{
    key: "clip",
    url: "https://manyvue.test/clip.mp4",
    size: 500_000,
    uploaded: "2026-08-02T00:00:00.000Z",
    contentType: "video/mp4",
    metadata: {
      participant: "camera-owner",
      kind: "burst-source",
      durationMs: "4000",
      burstOffsetMs: "1500",
    },
  }], "camera-owner");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].contactSheetUrl, undefined);
  assert.equal(candidates[0].availableDurationMs, 4_000);
});
