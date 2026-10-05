/**
 * Re-derive, for THIS workspace, what a move stripped from a row.
 *
 * `portableQueuePayload` (queue-portable.ts) drops the source workspace's
 * positioning (`yourEdge`/`yourClaim`) and its verdicts (`icpVerdict`,
 * `fitReason`) because they were written against another product and ICP.
 * Left at that, a moved row shows an empty case and drafts with no edge: its
 * `source` still names the trigger that found it elsewhere, which usually
 * has no edge here. This module fills them back in from the destination's own
 * config, the row's carried research, and at most two small model calls.
 *
 * Never throws and never changes a row's status. A `reject` verdict is
 * recorded, not acted on: the founder moved the row here on purpose.
 */
import { getLedger, loadConfig, logEvent, triggerNameForSource } from "@oneshot-gtm/core";
import {
  describeTargetForAngle,
  generateAlternativeAngles,
  generateFitReason,
} from "@oneshot-gtm/plays";
import { personPayloadPatch, personResearchOf, rejudgePerson } from "./_person-research.ts";

type JsonRecord = Record<string, unknown>;

/** Where a moved row's edge came from; shown in the review UI. */
export type RederivedEdgeSource = `destination-trigger:${string}` | "generated-on-move" | "none";

export interface RederivePatch extends JsonRecord {
  yourEdgeSource: RederivedEdgeSource;
}

interface TriggerLike {
  name: string;
  enabled?: number | boolean | null;
  config_json: string | null;
}

export interface RederiveInput {
  playName: string;
  source: string | null | undefined;
  payload: JsonRecord;
  /** The destination's triggers. Defaults to this workspace's ledger. */
  triggers?: readonly TriggerLike[];
  /** The destination's positioning. Defaults to this workspace's config. */
  positioning?: { product?: string; brief?: string; icp?: string };
}

/** The play reads its edge from `yourClaim` (hiring-signal) or `yourEdge` (every other play). */
export function edgeKeyForPlay(playName: string): "yourEdge" | "yourClaim" {
  return playName === "hiring-signal" ? "yourClaim" : "yourEdge";
}

function parseConfig(row: TriggerLike): JsonRecord | null {
  if (row.config_json == null) return null;
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function triggerEdge(config: JsonRecord): string {
  for (const key of ["yourEdge", "yourClaim"]) {
    const v = config[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * The destination trigger whose edge fits this row's play. First the trigger
 * the row's source names (same finder, same kind of evidence), unless it
 * routes its rows to a different play; then any trigger explicitly routed
 * (`play`) to this row's play, enabled ones first. Null when none has an edge.
 */
export function destinationTriggerEdge(
  playName: string,
  source: string | null | undefined,
  triggers: readonly TriggerLike[],
): { trigger: string; edge: string } | null {
  const own = triggerNameForSource(source);
  const candidates = triggers
    .map((t) => ({ t, config: parseConfig(t) }))
    .filter((c): c is { t: TriggerLike; config: JsonRecord } => c.config != null)
    .filter(({ config }) => triggerEdge(config) !== "");
  const ownMatch = candidates.find(({ t, config }) => {
    if (t.name !== own) return false;
    const routed = typeof config["play"] === "string" ? config["play"] : null;
    return routed === null || routed === playName;
  });
  if (ownMatch) return { trigger: ownMatch.t.name, edge: triggerEdge(ownMatch.config) };
  const routed = candidates
    .filter(({ config }) => config["play"] === playName)
    .toSorted((a, b) => Number(Boolean(b.t.enabled)) - Number(Boolean(a.t.enabled)));
  const pick = routed[0];
  return pick ? { trigger: pick.t.name, edge: triggerEdge(pick.config) } : null;
}

function researchText(payload: JsonRecord): string | null {
  const dossier = personResearchOf(payload);
  const parts = [
    dossier && dossier.status !== "unavailable" ? JSON.stringify(dossier) : undefined,
    payload["productResearch"] && typeof payload["productResearch"] === "object"
      ? JSON.stringify(payload["productResearch"])
      : undefined,
  ].filter((s): s is string => typeof s === "string");
  return parts.length ? parts.join("\n") : null;
}

async function deriveEdge(
  input: RederiveInput,
  positioning: { product?: string; brief?: string; icp?: string },
  triggers: readonly TriggerLike[],
): Promise<RederivePatch> {
  const key = edgeKeyForPlay(input.playName);
  const fromTrigger = destinationTriggerEdge(input.playName, input.source, triggers);
  if (fromTrigger) {
    return {
      [key]: fromTrigger.edge,
      yourEdgeSource: `destination-trigger:${fromTrigger.trigger}`,
    };
  }
  if (!positioning.product?.trim() && !positioning.brief?.trim()) {
    return { yourEdgeSource: "none" };
  }
  try {
    const [edge] = await generateAlternativeAngles({
      playName: input.playName,
      positioning: { ...positioning, edge: "" },
      prospect: describeTargetForAngle(input.payload, researchText(input.payload)),
      count: 1,
      excluded: [],
    });
    return edge ? { [key]: edge, yourEdgeSource: "generated-on-move" } : { yourEdgeSource: "none" };
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "rederive-edge",
        play: input.playName,
        message_120: (err as Error).message.slice(0, 120),
      },
      "warn",
    );
    return { yourEdgeSource: "none" };
  }
}

async function deriveFit(input: RederiveInput, icp: string | null): Promise<JsonRecord> {
  const out: JsonRecord = {};
  const dossier = personResearchOf(input.payload);
  if (dossier) {
    try {
      const judged = await rejudgePerson({
        playName: input.playName,
        payload: input.payload,
        patch: personPayloadPatch(input.payload, dossier),
        icp,
      });
      Object.assign(out, judged.patch);
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "rederive-icp",
          play: input.playName,
          message_120: (err as Error).message.slice(0, 120),
        },
        "warn",
      );
    }
  }
  // A reject reason says why they DON'T fit; it is not a fit line. Pass
  // already stamped one; anything else (unclear, no research, a failure)
  // gets a generated sentence from the destination's ICP.
  if (out["icpVerdict"] !== "reject" && typeof out["fitReason"] !== "string") {
    const reason = await generateFitReason({
      icp,
      playName: input.playName,
      payload: input.payload,
      dossier: researchText(input.payload),
    });
    if (reason) {
      out["fitReason"] = reason;
      out["fitReasonSource"] = "generated";
    }
  }
  return out;
}

/** The fields to merge onto a moved row's payload in this workspace. */
export async function rederiveMovedRow(input: RederiveInput): Promise<RederivePatch> {
  const cfg = input.positioning ? null : loadConfig();
  const positioning = input.positioning ?? {
    ...(cfg?.productOneLiner ? { product: cfg.productOneLiner } : {}),
    ...(cfg?.productBrief ? { brief: cfg.productBrief } : {}),
    ...(cfg?.icpOneLiner ? { icp: cfg.icpOneLiner } : {}),
  };
  const triggers = input.triggers ?? getLedger().listTriggers();
  const [edge, fit] = await Promise.all([
    deriveEdge(input, positioning, triggers),
    deriveFit(input, positioning.icp?.trim() || null),
  ]);
  return { ...fit, ...edge };
}

interface RederiveLedger {
  getQueueRow(id: number): {
    id: number;
    play_name: string;
    source: string | null;
    status: string;
    payload_json: string;
    notes: string | null;
    last_draft_json?: string | null;
  } | null;
  updateQueuePayload(input: { id: number; payload: unknown }): void;
  clearQueueDraft(id: number): void;
  setQueueNotes(input: { id: number; notes: string }): void;
}

export type RederiveOutcome =
  | { ok: true; patch: RederivePatch }
  | { ok: false; reason: "not-found" | "not-open" | "bad-payload" | "timeout" };

/** How long the background re-derivation may take before the row is flagged for a manual run. */
export const REDERIVE_DEADLINE_MS = 60_000;

/** The note a row keeps when re-derivation could not finish, naming the manual fix. */
export function rederiveFailedNote(id: number): string {
  return `edge not derived — run oneshot-gtm find rederive --id ${id}`;
}

/**
 * Re-derive one stored row and merge the result onto its CURRENT payload
 * (re-read after the model calls, so an edit made meanwhile survives). A
 * draft written before the edge existed is cleared so the next draft argues
 * from it. Status is never touched. Only open rows (pending/approved) are
 * changed; a sent or rejected row is history.
 */
export async function rederiveQueueRow(
  ledger: RederiveLedger,
  id: number,
  opts: { deadlineMs?: number; dryRun?: boolean; derive?: typeof rederiveMovedRow } = {},
): Promise<RederiveOutcome> {
  const row = ledger.getQueueRow(id);
  if (!row) return { ok: false, reason: "not-found" };
  if (row.status !== "pending" && row.status !== "approved")
    return { ok: false, reason: "not-open" };
  let payload: JsonRecord;
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    payload = parsed as JsonRecord;
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  const derive = opts.derive ?? rederiveMovedRow;
  const deadline = opts.deadlineMs ?? REDERIVE_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const patch = await Promise.race([
    derive({ playName: row.play_name, source: row.source, payload }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deadline);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!patch) {
    if (!opts.dryRun) {
      const note = rederiveFailedNote(id);
      const notes = row.notes?.includes(note)
        ? row.notes
        : [row.notes, note].filter(Boolean).join(" · ");
      ledger.setQueueNotes({ id, notes });
    }
    return { ok: false, reason: "timeout" };
  }
  if (opts.dryRun) return { ok: true, patch };
  const current = ledger.getQueueRow(id);
  if (!current || (current.status !== "pending" && current.status !== "approved")) {
    return { ok: false, reason: "not-open" };
  }
  let latest: JsonRecord = payload;
  try {
    latest = JSON.parse(current.payload_json) as JsonRecord;
  } catch {
    /* keep the payload read before the model calls */
  }
  ledger.updateQueuePayload({ id, payload: { ...latest, ...patch } });
  if (current.last_draft_json) ledger.clearQueueDraft(id);
  // A manual run after an earlier timeout: drop the "run rederive" note.
  const stale = rederiveFailedNote(id);
  if (current.notes?.includes(stale)) {
    const notes = current.notes
      .split(" · ")
      .filter((part) => part !== stale)
      .join(" · ");
    ledger.setQueueNotes({ id, notes });
  }
  return { ok: true, patch };
}
