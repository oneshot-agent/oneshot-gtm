/**
 * The row's one sentence (issue #592): `<signal> — <why they fit>`.
 *
 * The signal half is `queueEvidence` — the deterministic, per-play line the
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
