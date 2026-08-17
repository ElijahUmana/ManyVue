const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function equalConstantTime(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function signMediaKey(
  key: string,
  expiresAtSeconds: number,
  secret: string,
): Promise<string> {
  if (!key || !Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= 0 || secret.length < 32) {
    throw new Error("A media key, valid expiry, and 32-character signing secret are required.");
  }
  const signingKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    encoder.encode(`${expiresAtSeconds}:${key}`),
  );
  return base64Url(new Uint8Array(signature));
}

export async function verifyMediaKey(
  key: string,
  expiresAtSeconds: number,
  signature: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<boolean> {
  if (
    !key ||
    !signature ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds < nowSeconds ||
    expiresAtSeconds > nowSeconds + 7 * 24 * 60 * 60 ||
    secret.length < 32
  ) return false;
  const expected = await signMediaKey(key, expiresAtSeconds, secret);
  return equalConstantTime(expected, signature);
}

export async function signedMediaUrl(
  origin: string,
  key: string,
  secret: string,
  lifetimeSeconds = 24 * 60 * 60,
): Promise<string> {
  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + lifetimeSeconds;
  const signature = await signMediaKey(key, expiresAtSeconds, secret);
  const url = new URL("/api/uploads", origin);
  url.searchParams.set("key", key);
  url.searchParams.set("expires", String(expiresAtSeconds));
  url.searchParams.set("signature", signature);
  return url.toString();
}
