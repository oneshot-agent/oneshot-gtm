import {
  demoMode,
  getLedger,
  learningKeyOf,
  learningScopeKey,
  loadConfig,
  logEvent,
  tryReserveDailySpend,
  type TriggerRow,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import {
  checkReadiness,
  DEFAULT_APPROVAL_RATE_MIN_SAMPLES,
  DEFAULT_APPROVAL_RATE_THRESHOLD,
  effectiveIntervalMs,
  fireTriggerNow,
  finderApprovalHealth,
  getTriggerRunningSince,
  isTriggerRunning,
  storedTriggerConfig,
  TRIGGERS,
  type Readiness,
  type TriggerSpec,
} from "@oneshot-gtm/find";
import {
  edgeFieldOf,
  describeEdgeWarning,
  factTermsFrom,
  isAllowedDesignPartnerLoiBuyerType,
  lintEdge,
  splitEdgeAngles,
  type EdgeLintContext,
} from "@oneshot-gtm/plays";
import type {
  AngleSuggestionResult,
  RunTriggerResult,
  TriggerView,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import {
  angleUsageForEdge,
  draftUsageView,
  voiceUsageView,
  formatUsageView,
  playUsageLoader,
  type PlayUsage,
} from "./_draft-versions.ts";

export function toView(
  name: string,
  defaultIntervalMs: number,
  row: TriggerRow | null,
  spec: TriggerSpec | null,
  usage?: PlayUsage,
): TriggerView {
  let lastSummary: unknown = null;
  if (row?.last_run_summary) {
    try {
      lastSummary = JSON.parse(row.last_run_summary);
    } catch {
      lastSummary = row.last_run_summary;
    }
  }
  let config: Record<string, unknown> | null = null;
  if (row?.config_json) {
    try {
      const parsed = JSON.parse(row.config_json) as unknown;
      if (parsed && typeof parsed === "object") config = parsed as Record<string, unknown>;
    } catch {
      config = null;
    }
  }
  const defaultEnabled = spec ? spec.enabledByDefault !== false : true;
  const intervalMs = spec ? effectiveIntervalMs(spec, config) : defaultIntervalMs;
  const runningSinceMs = getTriggerRunningSince(name);
  // Explicit annotation keeps the discriminated-union narrowing intact
  // (the literal { ready: true } branch would otherwise widen the union).
  const readiness: Readiness = spec
    ? checkReadiness(spec, config ?? spec.defaultConfig)
    : { ready: true };
  const approval = spec
    ? finderApprovalHealth(name, config ?? spec.defaultConfig)
    : {
        rate: null,
        reviewed: 0,
        minSamples: DEFAULT_APPROVAL_RATE_MIN_SAMPLES,
        threshold: DEFAULT_APPROVAL_RATE_THRESHOLD,
        windowDays: 30,
        deprioritized: false,
        reason: null,
      };
  return {
    name,
    enabled: row ? Boolean(row.enabled) : defaultEnabled,
    defaultIntervalMs,
    intervalMs,
    config,
    defaultConfig: spec ? spec.defaultConfig : null,
    lastPolledAt: row?.last_polled_at ?? null,
    lastRunSummary: lastSummary,
    running: isTriggerRunning(name),
    runningSince: runningSinceMs != null ? new Date(runningSinceMs).toISOString() : null,
    ready: readiness.ready,
    notReadyReason: readiness.ready ? null : readiness.reason,
    approvalRate: approval.rate,
    approvalReviewed: approval.reviewed,
    approvalMinSamples: approval.minSamples,
    approvalRateThreshold: approval.threshold,
    approvalRateWindowDays: approval.windowDays,
    deprioritized: approval.deprioritized,
    deprioritizedReason: approval.reason,
    angleUsage: angleUsageForEdge(config ?? spec?.defaultConfig ?? null, usage?.angles ?? []),
    draftUsage: draftUsageView(usage?.drafts),
    voiceUsage: voiceUsageView(usage?.voice),
    formatUsage: formatUsageView(usage?.format),
  };
}

export function listTriggersRoute(req: Request): Response {
  const ledger = getLedger();
  const rows = ledger.listTriggers();
  const byName = new Map(rows.map((r) => [r.name, r]));
  const seen = new Set<string>();
  const views: TriggerView[] = [];
  // One pair of aggregate reads for the whole list; a trigger's name is its
  // play name, which is what draft versions are keyed by.
  const usage = playUsageLoader(ledger);
  for (const spec of TRIGGERS) {
    seen.add(spec.name);
    views.push(
      toView(
        spec.name,
        spec.defaultIntervalMs,
        byName.get(spec.name) ?? null,
        spec,
        usage(spec.name),
      ),
    );
  }
  // Surface any historical triggers stored in the ledger that no longer exist
  // in the registry (e.g. a deprecated cohort) so the founder can disable them.
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    views.push(toView(row.name, 24 * 3600 * 1000, row, null, usage(row.name)));
  }
  return jsonResponse({ triggers: views }, 200, req);
}

export async function setTriggerEnabledRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const name = params["name"];
  if (!name) return jsonResponse({ error: "name required" }, 400, req);
  let body: { enabled?: boolean } = {};
  try {
    body = (await req.json()) as { enabled?: boolean };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (typeof body.enabled !== "boolean") {
    return jsonResponse({ error: "enabled (boolean) required" }, 400, req);
  }
  const ledger = getLedger();
  const stored = ledger.getTrigger(name);
  const spec = TRIGGERS.find((t) => t.name === name) ?? null;
  // Readiness gate: block *enabling* an unready trigger so the scheduler
  // doesn't sit in a loop skipping it every tick. Disabling is always allowed.
  if (body.enabled && spec) {
    const config = storedTriggerConfig(stored, spec);
    const readiness = checkReadiness(spec, config);
    if (!readiness.ready) {
      return jsonResponse(
        {
          error: `trigger '${name}' not ready: ${readiness.reason}`,
          name,
          reason: readiness.reason,
        },
        409,
        req,
      );
    }
  }
  if (!stored) {
    if (!spec) return jsonResponse({ error: `unknown trigger '${name}'` }, 404, req);
    ledger.upsertTrigger({
      name,
      configJson: JSON.stringify(spec.defaultConfig),
      enabled: body.enabled,
    });
  } else {
    ledger.setTriggerEnabled(name, body.enabled);
  }
  return jsonResponse({ ok: true, name, enabled: body.enabled }, 200, req);
}

export async function setTriggerConfigRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const name = params["name"];
  if (!name) return jsonResponse({ error: "name required" }, 400, req);
  let body: { config?: unknown } = {};
  try {
    body = (await req.json()) as { config?: unknown };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (!body.config || typeof body.config !== "object") {
    return jsonResponse({ error: "config (object) required" }, 400, req);
  }
  // A refusal, unlike the warn-tier checks below: `angleAssignment` switches a
  // measurement on, and a misspelled value would silently keep the fit
  // classifier, so the founder would read a comparison that never ran.
  const assignment = (body.config as Record<string, unknown>)["angleAssignment"];
  if (assignment !== undefined && assignment !== "fit" && assignment !== "arm") {
    return jsonResponse(
      { error: "angleAssignment must be 'fit' (default) or 'arm' (even split across angles)" },
      400,
      req,
    );
  }
  const ledger = getLedger();
  const stored = ledger.getTrigger(name);
  if (!stored) {
    const spec = TRIGGERS.find((t) => t.name === name);
    if (!spec) return jsonResponse({ error: `unknown trigger '${name}'` }, 404, req);
    // A config write must never flip enablement: seeding an opt-in trigger's
    // row here (e.g. the /setup X card saving an engine choice before the
    // trigger was ever enabled) keeps the spec's default enablement.
    ledger.upsertTrigger({
      name,
      configJson: JSON.stringify(body.config),
      enabled: spec.enabledByDefault !== false,
    });
  } else {
    ledger.setTriggerConfig(name, JSON.stringify(body.config));
  }
  // Warn-tier edge lint (issue #585): this route is the one place both the
  // strategist's apply-config chip and the /queue JSON editor write through,
  // so it is where a founder learns their edge is a single flat pitch. Never
  // a refusal. The save above already happened; readiness stays a non-empty
  // check and `yourEdge: "x"` stays a valid fixture.
  const cfg = body.config as Record<string, unknown>;
  const edge =
    typeof cfg["yourEdge"] === "string"
      ? cfg["yourEdge"]
      : typeof cfg["yourClaim"] === "string"
        ? cfg["yourClaim"]
        : null;
  const warnings = edge ? lintEdge(edge, edgeLintContext()).map(describeEdgeWarning) : [];
  if (assignment === "arm" && splitEdgeAngles(edge ?? "").length < 2) {
    warnings.push(
      "angleAssignment 'arm' splits prospects across the edge's angles — add at least two `//`-separated angles, or nothing is compared",
    );
  }
  // Warn-tier `play`/`buyerType` validation never refuses the request:
  // the save above already happened, but a founder routing rows to
  // design-partner-loi with a missing/invalid buyerType should learn that
  // immediately rather than discover it only when the trigger silently
  // reports "not ready" later.
  if (cfg["play"] === "design-partner-loi") {
    const buyerType = cfg["buyerType"];
    if (typeof buyerType !== "string" || !isAllowedDesignPartnerLoiBuyerType(buyerType)) {
      warnings.push(
        "buyerType must be 'enterprise', 'government', or 'hardware' to route to design-partner-loi — this trigger will not run until it's set",
      );
    }
    // The routed edge field is a separate readiness gate from buyerType (see
    // `checkPlayRouteReadiness` in @oneshot-gtm/find): hiring-signal reads
    // `yourClaim`, every other routable finder reads `yourEdge`. Without this
    // warning a blank edge saved fine here but silently failed registry
    // readiness later, with no warning at save time (finding
    // PRRT_kwDOSKzrBs6mB73_, issue #705 round 1).
    const routeEdgeKey = name === "hiring-signal" ? "yourClaim" : "yourEdge";
    const routeEdge = cfg[routeEdgeKey];
    if (typeof routeEdge !== "string" || routeEdge.trim().length === 0) {
      warnings.push(
        `${routeEdgeKey} is required to route to design-partner-loi — this trigger will not run until it's set`,
      );
    }
  }
  return jsonResponse({ ok: true, name, warnings }, 200, req);
}

/**
 * What an opportunity angle may lean on as its fact: the product's own
 * description. A config read failure only weakens the check (numbers still
 * count). The lint is guidance and must never fail a save.
 */
function edgeLintContext(): EdgeLintContext {
  try {
    const cfg = loadConfig();
    return { factTerms: factTermsFrom(cfg.productOneLiner, cfg.productBrief) };
  } catch {
    return {};
  }
}

/** Fire-and-forget: 202 on kick-off, 409 if already running. UI polls `GET /api/triggers`. */
export function runTriggerRoute(req: Request, params: Record<string, string>): Response {
  const name = params["name"];
  if (!name) return jsonResponse({ error: "name required" }, 400, req);
  if (!TRIGGERS.some((t) => t.name === name)) {
    return jsonResponse({ error: `unknown trigger '${name}'` }, 404, req);
  }
  try {
    fireTriggerNow(name);
  } catch (err) {
    const message = (err as Error).message ?? "failed to fire";
    if (message.includes("already running")) {
      return jsonResponse({ error: message, name, running: true }, 409, req);
    }
    if (message.startsWith("not ready:")) {
      const reason = message.slice("not ready:".length).trim();
      return jsonResponse({ error: message, name, reason, ready: false }, 409, req);
    }
    return jsonResponse({ error: message }, 500, req);
  }
  const view: RunTriggerResult = {
    name,
    fired: true,
    pending: true,
    result: null,
    error: null,
  };
  return jsonResponse(view, 202, req);
}

/** Reply intents that read as the pitch running into something (#813). */
const OBJECTION_INTENTS = ["objection", "not_interested", "wrong_person", "not_now"] as const;
const OBJECTION_LIMIT = 20;
/** The prompt's own rules, enforced here too: never retire on a thin sample, keep the set reviewable. */
const MIN_OFFERS_TO_RETIRE = 5;
const MIN_ANGLES = 2;
const MAX_ANGLES = 5;
/** Angles are `//`-joined in the edge field; the same separator `splitEdgeAngles` reads. */
const ANGLE_JOIN = " // ";

const normalizeAngle = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
/** The model's string lists, with anything that is not a non-empty string dropped. */
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];

/**
 * POST /api/triggers/:name/suggest-angles (#813). An explicit founder
 * action: read what happened to each configured angle (`angleUsageByPlay`)
 * and the objections replies raised, ask the model for keep / retire / add,
 * and record the result as a PENDING `campaign_angle` proposal labelled a
 * hypothesis. Nothing changes here: approval on /queue writes the edge
 * field, and the arm split and fit classifier keep running as configured.
 * Never a winner claim: the counts are observational.
 */
export async function suggestAnglesRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  if (demoMode()) return jsonResponse({ error: "The demo is read-only." }, 403, req);
  const name = params["name"] ?? "";
  const spec = TRIGGERS.find((t) => t.name === name);
  const ledger = getLedger();
  const stored = ledger.getTrigger(name);
  if (!spec && !stored) return jsonResponse({ error: `unknown trigger '${name}'` }, 404, req);
  let config: Record<string, unknown> | null = null;
  try {
    config = stored?.config_json
      ? (JSON.parse(stored.config_json) as Record<string, unknown>)
      : ((spec?.defaultConfig as Record<string, unknown> | undefined) ?? null);
  } catch {
    config = null;
  }
  const field = config ? edgeFieldOf(config) : null;
  const edge = field && config ? String(config[field]) : "";
  const angles = splitEdgeAngles(edge);
  if (!field || angles.length === 0)
    return jsonResponse(
      { error: "this trigger has no yourEdge / yourClaim angles to suggest changes to" },
      400,
      req,
    );
  const usage = angleUsageForEdge(config, playUsageLoader(ledger)(name).angles);
  const method = config?.["angleAssignment"] === "arm" ? "arm" : "fit";
  // The aggregate counts span every selection method the play ever ran
  // under. Under an even split only the arm-assigned counters compare
  // angles fairly; any excess over them is fit-selected history and is
  // labelled as such rather than passed off as the split's evidence.
  const angleRows = usage?.angles ?? [];
  const mixedHistory = method === "arm" && angleRows.some((a) => a.offered > (a.armOffered ?? 0));
  const countsOf = (a: (typeof angleRows)[number]) =>
    method === "arm"
      ? {
          offered: a.armOffered ?? 0,
          rotatedAway: a.rotatedAway,
          redrafted: a.redrafted,
          sent: a.sent,
          autoSent: a.autoSent,
          reached: a.armReached ?? 0,
          replied: a.armReplied ?? 0,
          allOffered: a.offered,
        }
      : {
          offered: a.offered,
          rotatedAway: a.rotatedAway,
          redrafted: a.redrafted,
          sent: a.sent,
          autoSent: a.autoSent,
          reached: a.reached,
          replied: a.replied,
          allOffered: a.offered,
        };
  const objections = ledger.listRepliesByIntentForPlay(name, OBJECTION_INTENTS, OBJECTION_LIMIT);
  const baselineKey = learningKeyOf(edge);
  const scopeKey = learningScopeKey("campaign_angle", { playName: name });

  const reservation = tryReserveDailySpend(1);
  if (!reservation.granted)
    return jsonResponse(
      { error: `paused by the daily spend limit: ${reservation.reason}` },
      429,
      req,
    );
  const cfg = loadConfig();
  try {
    const response = await complete({
      messages: [
        { role: "system", content: loadPrompt("angle-campaign-suggest") },
        {
          role: "user",
          content: JSON.stringify({
            play: name,
            positioning: {
              product: cfg.productOneLiner,
              brief: cfg.productBrief,
              icp: cfg.icpOneLiner,
              edge,
            },
            method,
            countsBasis:
              method === "arm"
                ? "offered/reached/replied count arm-assigned prospects only; rotatedAway/redrafted/sent span all history"
                : "all reviewed drafts",
            mixedHistory,
            angles: angles.map((text) => {
              const row = angleRows.find((a) => a.text === text);
              return row
                ? { text, ...countsOf(row) }
                : {
                    text,
                    offered: 0,
                    rotatedAway: 0,
                    redrafted: 0,
                    sent: 0,
                    autoSent: 0,
                    reached: 0,
                    replied: 0,
                    allOffered: 0,
                  };
            }),
            generated: usage?.generated ?? null,
            objections: objections.map((r) => ({ intent: r.intent, body: r.body.slice(0, 400) })),
          }),
        },
      ],
      temperature: 0.2,
      maxTokens: 900,
      timeoutMs: 60_000,
    });
    const parsed = tryParseJsonObject<{
      keep?: unknown;
      retire?: unknown;
      add?: unknown;
      rationale?: unknown;
    }>(response.content, {});
    const current = new Map(angles.map((a) => [normalizeAngle(a), a]));
    const keep = strings(parsed.keep)
      .map((a) => current.get(normalizeAngle(a)))
      .filter((a): a is string => !!a);
    const retire = strings(parsed.retire)
      .map((a) => current.get(normalizeAngle(a)))
      .filter((a): a is string => !!a);
    // An addition carrying the separator would silently become several
    // angles once the edge is split; it is not one argument.
    const add = strings(parsed.add)
      .map((a) => a.trim())
      .filter((a) => !a.includes("//") && !current.has(normalizeAngle(a)))
      .slice(0, 2);
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
    // Angles the model forgot to classify stay: a silent drop is not a
    // suggestion. Nor is retiring an angle on a thin sample: fewer than
    // MIN_OFFERS_TO_RETIRE offers keeps it, whatever the model said.
    const offeredOf = (text: string) => {
      const row = angleRows.find((a) => a.text === text);
      return row ? countsOf(row).offered : 0;
    };
    const retired = new Set(retire.filter((a) => offeredOf(a) >= MIN_OFFERS_TO_RETIRE));
    const keptSet = new Set(keep);
    const kept = angles.filter((a) => !retired.has(a) || keptSet.has(a));
    const keptNow = new Set(kept);
    const proposedAngles = [...kept, ...add];
    const proposedEdge = proposedAngles.join(ANGLE_JOIN);
    const unchanged =
      proposedAngles.length === angles.length &&
      proposedAngles.every((a, i) => normalizeAngle(a) === normalizeAngle(angles[i]!));
    const outOfBounds =
      proposedAngles.length < MIN_ANGLES ||
      proposedAngles.length > MAX_ANGLES ||
      // A one-angle set may grow; it never shrinks below two by suggestion.
      (proposedAngles.length < angles.length && proposedAngles.length < MIN_ANGLES);
    if (unchanged || proposedAngles.length === 0 || !rationale || outOfBounds) {
      logEvent("angle.suggest.unchanged", { play: name });
      const out: AngleSuggestionResult = {
        ok: true,
        proposal: null,
        reason: "the counts do not justify a change yet",
      };
      return jsonResponse(out, 200, req);
    }
    const dedupeKey = `${name}:${learningKeyOf(normalizeAngle(proposedEdge))}`;
    if (
      ledger.learning.hasPendingDuplicate("campaign_angle", dedupeKey) ||
      ledger.learning.wasJustDismissed("campaign_angle", dedupeKey, scopeKey)
    ) {
      const out: AngleSuggestionResult = {
        ok: true,
        proposal: null,
        reason: "the same change is already pending, or you just dismissed it",
      };
      return jsonResponse(out, 200, req);
    }
    const counts: Record<string, number> = {
      angles: angles.length,
      retire: angles.length - kept.length,
      add: add.length,
      objections: objections.length,
    };
    for (const a of angleRows) {
      const i = angles.indexOf(a.text) + 1;
      const c = countsOf(a);
      counts[`angle${i}_offered`] = c.offered;
      counts[`angle${i}_sent`] = c.sent + c.autoSent;
      counts[`angle${i}_replied`] = c.replied;
    }
    if (mixedHistory) counts["mixed_history"] = 1;
    const view = ledger.learning.insert({
      kind: "campaign_angle",
      scope: { playName: name },
      current: { field, edge },
      proposed: {
        field,
        edge: proposedEdge,
        keep: kept,
        retire: angles.filter((a) => !keptNow.has(a)),
        add,
      },
      evidence: {
        refs: objections.map((r) => ({ type: "inbox_reply", id: r.id })),
        samples: objections.slice(0, 5).map((r) => ({
          at: r.received_at,
          label: `Reply · ${r.intent ?? "objection"}`,
          text: r.body.slice(0, 300),
        })),
        counts,
        method,
      },
      evidenceSummary: `${rationale} Hypothesis from observational counts under ${
        method === "arm"
          ? mixedHistory
            ? "an even split (offered/reached/replied count arm-assigned prospects only; the play also ran under fit selection before)"
            : "an even split"
          : "fit selection"
      }; no causal claim.`,
      baselineKey,
      dedupeKey,
    });
    logEvent("angle.suggest.proposed", {
      play: name,
      retire: counts["retire"],
      add: counts["add"],
    });
    const out: AngleSuggestionResult = { ok: true, proposal: view };
    return jsonResponse(out, 200, req);
  } catch (err) {
    logEvent(
      "angle.suggest.failed",
      { play: name, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return jsonResponse({ error: "could not suggest angle changes; try again" }, 500, req);
  } finally {
    reservation.release();
  }
}
