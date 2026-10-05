/**
 * The row's one sentence (issue #592): `<signal> — <why they fit>`.
 *
 * The signal half is `queueEvidence`. The deterministic, per-play line the
 * row already had ("cohort YC Summer 2026", "starred X", "raised Seed · $4.2M").
 * The fit half is the `fitReason` every finder now stamps onto the payload
 * (company-gate reason, person-gate reason, or one generated sentence). Both
 * are pure reads; privacy-mode suppression stays at the call site, exactly
 * where the evidence line's was, because both halves are freeform text.
 *
 * Contract, so a row never renders a dangling dash: both → joined; one → that
 * half alone; neither → null; identical halves → one copy.
 */
import { queueEvidence } from "./queueEvidence.ts";

export function fitReasonFor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const v = (payload as Record<string, unknown>)["fitReason"];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function rationaleLine(playName: string, payload: unknown): string | null {
  const signal = queueEvidence(playName, payload);
  const fit = fitReasonFor(payload);
  if (signal && fit) return signal === fit ? signal : `${signal} — ${fit}`;
  return signal ?? fit;
}

/**
 * "moved from X · edge …" for a row that arrived from another workspace:
 * where its edge here came from (queue-rederive.ts), so a generated one is
 * never mistaken for configured positioning. Null for any other row.
 */
export function movedProvenance(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const from = p["movedFrom"];
  if (!from || typeof from !== "object") return null;
  const workspace = (from as { workspace?: unknown }).workspace;
  const head =
    typeof workspace === "string" && workspace ? `moved from ${workspace}` : "moved here";
  const src = p["yourEdgeSource"];
  if (typeof src !== "string") return `${head} · edge not derived yet`;
  if (src.startsWith("destination-trigger:")) {
    return `${head} · edge from this workspace's ${src.slice("destination-trigger:".length)} trigger`;
  }
  if (src === "generated-on-move") return `${head} · edge generated for this workspace`;
  return `${head} · no edge here (add product positioning in Setup)`;
}

/** The ICP reject reason on a MOVED row: shown, not acted on (the founder moved it on purpose). */
export function movedRejectReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p["movedFrom"] == null || p["icpVerdict"] !== "reject") return null;
  const reason = p["icpVerdictReason"];
  return typeof reason === "string" && reason.trim() ? reason.trim() : "does not fit this ICP";
}
