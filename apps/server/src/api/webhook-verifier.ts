import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_REPLAY_WINDOW_SECONDS = 5 * 60;

const seen = new Map<string, number>();

export type WebhookVerification =
  | { ok: true }
  | { ok: false; error: "invalid webhook signature" | "stale webhook" | "replayed webhook" };

/**
 * Verify a `t=<unix-seconds>,v1=<sha256-hex>` signature over
 * `<timestamp>.<raw request body>`. An empty configured secret deliberately
 * leaves verification disabled for backwards-compatible local installs.
 */
export function verifyWebhook(
  signature: string | null,
  payload: string,
  configuredSecret: string | undefined,
  now = Date.now(),
): WebhookVerification {
  const secret = configuredSecret?.trim() ?? "";
  if (!secret) return { ok: true };

  const parsed = parseSignature(signature);
  if (!parsed) return { ok: false, error: "invalid webhook signature" };

  const timestampMs = parsed.timestamp * 1_000;
  if (Math.abs(now - timestampMs) > WEBHOOK_REPLAY_WINDOW_SECONDS * 1_000) {
    return { ok: false, error: "stale webhook" };
  }

  const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${payload}`).digest();
  const valid = parsed.signatures.some((candidate) => safeDigestEqual(expected, candidate));
  if (!valid) return { ok: false, error: "invalid webhook signature" };

  pruneSeen(now);
  const replayKey = `${parsed.timestamp}:${expected.toString("hex")}`;
  if (seen.has(replayKey)) return { ok: false, error: "replayed webhook" };
  seen.set(replayKey, timestampMs + WEBHOOK_REPLAY_WINDOW_SECONDS * 1_000);
  return { ok: true };
}

function parseSignature(value: string | null): { timestamp: number; signatures: Buffer[] } | null {
  if (!value) return null;
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of value.split(",")) {
    const [key, raw, ...rest] = part.trim().split("=");
    if (!raw || rest.length > 0) continue;
    if (key === "t" && /^\d+$/.test(raw)) timestamp = Number(raw);
    if (key === "v1" && /^[a-f\d]{64}$/i.test(raw)) signatures.push(Buffer.from(raw, "hex"));
  }
  if (!Number.isSafeInteger(timestamp) || timestamp === null || signatures.length === 0)
    return null;
  return { timestamp, signatures };
}

function safeDigestEqual(expected: Buffer, candidate: Buffer): boolean {
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

function pruneSeen(now: number): void {
  for (const [key, expiresAt] of seen) {
    if (expiresAt < now) seen.delete(key);
  }
}

/** Test-only process-state reset. */
export function resetWebhookReplayCache(): void {
  seen.clear();
}
