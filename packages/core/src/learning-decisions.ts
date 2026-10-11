import { loadConfig, saveConfig, withConfigLock } from "./config.ts";
import { learningKeyOf, learningScopeKey } from "./learning-store.ts";
import { normalizeIcpText } from "./icp-proposal-store.ts";
import type { Ledger } from "./ledger.ts";
import type { LearningKind, LearningProposalView } from "@oneshot-gtm/shared-types";

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const asText = (v: unknown): string | null => (typeof v === "string" ? v.trim() : null);

interface KindHandler {
  /** The active value's fingerprint right now, compared with the proposal's `baselineKey`. */
  baselineKey(ledger: Ledger, p: LearningProposalView): string | null;
  /** Shape-check and normalize an edited value; null means "approve as proposed". */
  edited(p: LearningProposalView, value: unknown): { value: unknown } | { error: string };
  apply(ledger: Ledger, p: LearningProposalView, value: unknown, now: string): void;
  revert(ledger: Ledger, p: LearningProposalView, now: string): void;
}

/** Campaign angles live in one field of the trigger's config_json (`yourEdge`, or `yourClaim` for hiring-signal). */
function triggerEdge(
  ledger: Ledger,
  playName: string,
): { config: Record<string, unknown>; field: string; edge: string } | null {
  const row = ledger.getTrigger(playName);
  if (!row) return null;
  let config: Record<string, unknown> = {};
  try {
    config = asRecord(JSON.parse(row.config_json ?? "{}")) ?? {};
  } catch {
    config = {};
  }
  const field =
    typeof config["yourClaim"] === "string" && !config["yourEdge"] ? "yourClaim" : "yourEdge";
  return {
    config,
    field,
    edge: typeof config[field] === "string" ? (config[field] as string) : "",
  };
}

const HANDLERS: Record<LearningKind, KindHandler> = {
  icp: {
    baselineKey: () => normalizeIcpText(loadConfig().icpOneLiner ?? ""),
    edited: (_p, value) => {
      const text = asText(value);
      if (!text) return { error: "an edited ICP must be a non-empty string" };
      if (text.length > 1000) return { error: "an ICP one-liner is at most 1000 characters" };
      return { value: text };
    },
    apply: (_ledger, _p, value) => {
      saveConfig({ ...loadConfig(), icpOneLiner: value as string });
    },
    revert: (_ledger, p) => {
      saveConfig({ ...loadConfig(), icpOneLiner: asText(p.current) ?? null });
    },
  },
  prospect_angle: {
    baselineKey: (ledger, p) => {
      const id = p.scope.prospectId;
      if (id == null) return null;
      const prospect = ledger.getProspectById(id);
      if (!prospect) return null;
      return learningKeyOf(prospect.angle_json ?? "");
    },
    edited: (p, value) => {
      const edit = asRecord(value);
      const base = asRecord(p.proposed);
      if (!edit || !base) return { error: "an edited angle must be an object" };
      const merged = { ...base, ...edit };
      if (!asText(merged["hook"])) return { error: "an angle needs a non-empty hook" };
      return { value: merged };
    },
    apply: (ledger, p, value, now) => {
      const id = p.scope.prospectId!;
      if (!ledger.getProspectById(id)) throw new Error(`prospect #${id} not found`);
      ledger.setProspectAngle(id, JSON.stringify(value), { approvedAt: now });
    },
    revert: (ledger, p) => {
      const id = p.scope.prospectId!;
      const before = asRecord(p.current);
      const angleJson =
        before && typeof before["angleJson"] === "string" ? before["angleJson"] : null;
      const approvedAt =
        before && typeof before["approvedAt"] === "string" ? before["approvedAt"] : null;
      ledger.setProspectAngle(id, angleJson, { approvedAt });
    },
  },
  campaign_angle: {
    baselineKey: (ledger, p) => {
      if (!p.scope.playName) return null;
      const t = triggerEdge(ledger, p.scope.playName);
      return t ? learningKeyOf(t.edge) : null;
    },
    edited: (p, value) => {
      const edit = asRecord(value);
      const base = asRecord(p.proposed);
      const edge = asText(edit?.["edge"] ?? value);
      if (!edge) return { error: "an edited angle set must be a non-empty `edge` string" };
      return { value: { ...base, edge } };
    },
    apply: (ledger, p, value) => {
      const t = triggerEdge(ledger, p.scope.playName!);
      if (!t) throw new Error(`trigger '${p.scope.playName}' not found`);
      const edge = asText(asRecord(value)?.["edge"]);
      // An empty edge would un-ready the trigger: refuse, so the decision reverts.
      if (!edge) throw new Error("approved angle set has no edge");
      ledger.setTriggerConfig(p.scope.playName!, JSON.stringify({ ...t.config, [t.field]: edge }));
    },
    revert: (ledger, p) => {
      const t = triggerEdge(ledger, p.scope.playName!);
      if (!t) throw new Error(`trigger '${p.scope.playName}' not found`);
      const edge = asText(asRecord(p.current)?.["edge"]) ?? "";
      ledger.setTriggerConfig(p.scope.playName!, JSON.stringify({ ...t.config, [t.field]: edge }));
    },
  },
  preference: {
    // Guidance only ever accumulates: there is no single active value to drift.
    baselineKey: () => "",
    edited: (p, value) => {
      const base = asRecord(p.proposed);
      const instruction = asText(asRecord(value)?.["instruction"] ?? value);
      if (!instruction) return { error: "an edited preference must be a non-empty instruction" };
      if (instruction.length > 500) return { error: "a preference is at most 500 characters" };
      return { value: { ...base, instruction } };
    },
    apply: (ledger, p, value, now) => {
      const v = asRecord(value) ?? {};
      const source = v["source"];
      ledger.learning.addGuidance({
        instruction: asText(v["instruction"]) ?? "",
        source: source === "explicit" || source === "edits" ? source : "style",
        channel: p.scope.channel ?? null,
        stage: p.scope.stage ?? null,
        proposalId: p.id,
        evidence: p.evidence,
        now,
      });
    },
    revert: (ledger, p, now) => {
      for (const g of ledger.learning.listGuidance(true))
        if (g.proposalId === p.id) ledger.learning.rollbackGuidance(g.id, now);
    },
  },
};

export class LearningDecisionError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

function finish(
  ledger: Ledger,
  p: LearningProposalView,
  action: "approve" | "rollback",
  value: unknown,
  now: string,
) {
  const result =
    action === "approve"
      ? ledger.learning.decide(p.id, "approved", now, value)
      : ledger.learning.rollback(p.id, now);
  if ("error" in result) throw new LearningDecisionError(result.error);
  if (action === "approve") {
    ledger.learning.markApplied(p.id, now);
    ledger.learning.db
      .query("UPDATE learning_proposals SET applied_key=? WHERE id=?")
      .run(HANDLERS[p.kind].baselineKey(ledger, p), p.id);
  }
  if (p.kind !== "preference")
    ledger.learning.markStale(p.kind, learningScopeKey(p.kind, p.scope), now, p.id);
}

/** Reconcile an interrupted config-file write against its durable intent. Never overwrite a newer manual value. */
export function recoverLearningApplications(ledger: Ledger): void {
  withConfigLock(() => {
    const rows = ledger.learning.db
      .query<
        {
          id: string;
          action: "approve" | "rollback";
          value_json: string;
          previous_json: string;
          created_at: string;
        },
        []
      >("SELECT * FROM learning_applications")
      .all();
    for (const row of rows) {
      const p = ledger.learning.get(row.id);
      if (!p) throw new LearningDecisionError("Interrupted learning decision has no proposal");
      const desired = JSON.parse(row.value_json) as string | null;
      const previous = JSON.parse(row.previous_json) as string | null;
      const active = loadConfig().icpOneLiner ?? null;
      if (active !== desired && active !== previous)
        throw new LearningDecisionError(
          "An interrupted ICP decision conflicts with a newer configuration; review it before continuing.",
        );
      ledger.learning.db
        .transaction(() => {
          if (active === desired) finish(ledger, p, row.action, desired, row.created_at);
          ledger.learning.db.query("DELETE FROM learning_applications WHERE id=?").run(p.id);
        })
        .immediate();
    }
  });
}

/** All proposal endpoints share this lock, baseline check, and transactional application. */
export function decideLearning(
  ledger: Ledger,
  id: string,
  action: "approve" | "dismiss" | "rollback",
  edited?: unknown,
): LearningProposalView {
  return withConfigLock(() => {
    recoverLearningApplications(ledger);
    const p = ledger.learning.get(id);
    if (!p) throw new LearningDecisionError(`proposal '${id}' not found`);
    if (action === "dismiss") {
      const result = ledger.learning.decide(id, "dismissed", new Date().toISOString());
      if ("error" in result) throw new LearningDecisionError(result.error);
      return result.view;
    }
    if (p.status !== (action === "approve" ? "pending" : "approved"))
      throw new LearningDecisionError(`proposal '${id}' is ${p.status}`);
    const handler = HANDLERS[p.kind];
    let value = p.proposed;
    if (action === "approve" && edited !== undefined) {
      const edit = handler.edited(p, edited);
      if ("error" in edit) throw new LearningDecisionError(edit.error, 400);
      value = edit.value;
    }
    const now = new Date().toISOString();
    const check = () => {
      const current = ledger.learning.get(id)!;
      const expected = action === "approve" ? "pending" : "approved";
      if (current.status !== expected)
        throw new LearningDecisionError(`proposal '${id}' is ${current.status}, not ${expected}`);
      const active = handler.baselineKey(ledger, p);
      if (action === "approve") {
        if (active === null || active !== p.baselineKey)
          throw new LearningDecisionError(
            "The active value has changed since this proposal was generated; dismiss it and wait for a fresh one.",
          );
      } else if (p.kind !== "preference") {
        const recorded = ledger.learning.db
          .query<{ applied_key: string | null }, [string]>(
            "SELECT applied_key FROM learning_proposals WHERE id=?",
          )
          .get(id)?.applied_key;
        const applied = p.decided ?? p.proposed;
        const expectedKey =
          recorded ??
          (p.kind === "icp"
            ? normalizeIcpText(String(applied))
            : learningKeyOf(
                p.kind === "campaign_angle"
                  ? (asRecord(applied)?.["edge"] ?? "")
                  : JSON.stringify(applied),
              ));
        if (active === null || active !== expectedKey)
          throw new LearningDecisionError(
            "The active value has changed since approval; rolling back would overwrite a newer decision.",
          );
        const newer = ledger.learning.db
          .query(
            "SELECT 1 FROM learning_proposals WHERE kind=? AND scope_key=? AND status='approved' AND applied_at IS NOT NULL AND (applied_at > ? OR (applied_at = ? AND rowid>(SELECT rowid FROM learning_proposals WHERE id=?)))",
          )
          .get(p.kind, learningScopeKey(p.kind, p.scope), p.appliedAt, p.appliedAt, id);
        if (newer) throw new LearningDecisionError("A newer approval must be rolled back first.");
      }
    };
    if (p.kind === "icp") {
      ledger.learning.db
        .transaction(() => {
          check();
          ledger.learning.db
            .query("INSERT INTO learning_applications VALUES(?,?,?,?,?)")
            .run(
              id,
              action,
              JSON.stringify(action === "approve" ? value : p.current),
              JSON.stringify(loadConfig().icpOneLiner ?? null),
              now,
            );
        })
        .immediate();
      try {
        if (action === "approve") handler.apply(ledger, p, value, now);
        else handler.revert(ledger, p, now);
      } catch (e) {
        recoverLearningApplications(ledger);
        throw new LearningDecisionError(
          `Could not apply the learned change: ${(e as Error).message}`,
          500,
        );
      }
      recoverLearningApplications(ledger);
    } else {
      try {
        ledger.learning.db
          .transaction(() => {
            check();
            if (action === "approve") handler.apply(ledger, p, value, now);
            else handler.revert(ledger, p, now);
            finish(ledger, p, action, value, now);
          })
          .immediate();
      } catch (e) {
        if (e instanceof LearningDecisionError) throw e;
        throw new LearningDecisionError(
          `Could not apply the learned change: ${(e as Error).message}`,
          500,
        );
      }
    }
    return ledger.learning.get(id)!;
  });
}
