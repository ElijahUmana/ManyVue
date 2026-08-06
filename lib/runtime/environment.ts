import { env as workerEnv } from "cloudflare:workers";

type RuntimeBindings = Record<string, unknown>;

/**
 * Read hosted values from the Worker's runtime bindings. Secret Sites values
 * intentionally are not exposed through the build-time process.env shim.
 */
export function runtimeValue(key: string): string | undefined {
  const binding = (workerEnv as unknown as RuntimeBindings)[key];
  if (typeof binding === "string" && binding.length > 0) return binding;
  const fallback = process.env[key];
  return fallback && fallback.length > 0 ? fallback : undefined;
}
