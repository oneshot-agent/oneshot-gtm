import {
  currentWorkspaceName,
  demoMode,
  getLedger,
  getLinkedInInboxStore,
  getReplyReviewStore,
  learningScopeKey,
  linkedinWriterOf,
  loadConfig,
  logEvent,
  normalizeLearnedText,
  TEMPLATED_LINKEDIN_SCOPE_KEYS,
  tryReserveDailySpend,
  type AcceptedCandidate,
  type DraftObservation,
  type Ledger,
  type LearningObservation,
  type PreferenceCandidate,
  type ReplyLearningStore,
} from "@oneshot-gtm/core";
import {
  nearDuplicateText,
  type LearningChannel,
  type LearningEvidence,
  type LearningEvidenceSample,
  type LearningStage,
} from "@oneshot-gtm/shared-types";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";

/**
 * Writing-preference learning (#813, generalising #669's LinkedIn reply
 * learning). Scheduler-only: no drafting or send path waits for it. It
 * reads two kinds of evidence —
 *
 *   reply sends on email and LinkedIn (`ReplyLearningStore`: the machine
 *   original, the founder's edits and explicit feedback, the confirmed
 *   send), and
 *
 *   reviewed first touches and follow-ups (`draft_versions`: what the
 *   founder sent next to the machine drafts they regenerated away from;
 *   style evidence only, since those drafts cannot be edited) —
 *
 * and turns what the model extracts into PENDING proposals in the ledger's
 * `LearningStore`. Nothing here applies to a draft: only a founder approval
 * on /queue turns a proposal into guidance.
 */
/**
 * The extraction prompt (`packages/prompts/learning-style.md`): how the
 * founder writes, never what to argue. Content is suggested only from
 * replies (`outcome-learning.ts`).
 */
export const learningStylePrompt = (): string => loadPrompt("learning-style");

/** Lease kinds in the ledger's `learning_jobs`: the draft-evidence watermark and the one-time v1 import. */
const DRAFT_JOB = "preference";
const LEGACY_JOB = "preference-legacy";
const LEASE_MS = 240_000;
const COOLDOWN_MS = 300_000;

/**
 * Reviewed sends an area (channel and stage) needs after its last proposal
 * or decision before it gets another proposal: the scheduler runs every few
 * minutes, and the same evidence read again only rewords what it said.
 */
export const MIN_NEW_EVIDENCE_SENDS = 10;

/** Draft observation ids are namespaced so they cannot collide with a reply send id. */
const draftId = (o: DraftObservation) => `draft:${o.id}`;

const asChannel = (c: string): LearningChannel | null =>
  c === "email" || c === "linkedin" ? c : null;

/**
 * Phrasings that tell the writer what to argue rather than how to write:
 * "highlight the savings", "propose a pilot", "mention that ...", "position
 * the tool as ...". Draft evidence is style evidence only; what to argue
 * belongs to offers and angles, and to replies (`outcome-learning.ts`).
 * Generic English, cheap, and deliberately narrow: an instruction about
 * length, tone, structure, openings, sign-offs or the shape of a question
 * matches none of these.
 */
const CONTENT_DIRECTIVES: readonly RegExp[] = [
  /\bhighlight(?:s|ed|ing)?\b/i,
  /\bpropos(?:e|es|ed|ing)\b/i,
  /\bpitch(?:es|ed|ing)?\b/i,
  /\bemphasi[sz](?:e|es|ed|ing)\b/i,
  /\bshowcas(?:e|es|ed|ing)\b/i,
  /\btout(?:s|ed|ing)?\b/i,
  /\bmention(?:s|ed|ing)?\s+(?:that|how|why|our|your)\b/i,
  /\b(?:observ|not)(?:e|es|ed|ing)\s+that\b/i,
  /\bpoint(?:s|ed|ing)?\s+out\b/i,
  /\bposition(?:s|ed|ing)?\s+(?:\S+\s+){1,5}?as\b/i,
  // "Lead with the cost savings", "focus on pricing": content, unless what
  // follows is a way of writing ("lead with a question", "focus on clarity")
  // that ends there: "the length of the free trial" names a subject.
  /\b(?:lead(?:s|ing)?\s+with|focus(?:es|ed|ing)?\s+on)\s+(?!(?:a|an|one|the|their|your)?\s*(?:short|single|plain|direct|brief|open|clear)?\s*(?:clarity|brevity|question|sentence|line|greeting|name|point|ask|tone|register|wording|structure|length)\b(?!\s+(?:of|about|for)\b))/i,
];

/** True when an instruction directs content (what to argue) instead of style. */
export function directsContent(instruction: string): boolean {
  return CONTENT_DIRECTIVES.some((rx) => rx.test(instruction));
}

/**
 * Style candidates over draft evidence: `style` only, five distinct
 * prospects, every citation real, and about how to write, not what to
 * argue (`directsContent`). Returns the scoped candidates.
 */
export function acceptDraftCandidates(
  candidates: PreferenceCandidate[],
  drafts: DraftObservation[],
): Array<{
  key: string;
  instruction: string;
  channel: LearningChannel | null;
  stage: DraftObservation["stage"];
  evidence: DraftObservation[];
}> {
  const byId = new Map(drafts.map((o) => [draftId(o), o]));
  const out: ReturnType<typeof acceptDraftCandidates> = [];
  const seen = new Set<string>();
  for (const c of candidates.slice(0, 24)) {
    if (
      !c ||
      typeof c.key !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(c.key) ||
      typeof c.instruction !== "string" ||
      !c.instruction.trim() ||
      c.instruction.length > 500 ||
      c.source !== "style" ||
      directsContent(c.instruction) ||
      !Array.isArray(c.evidenceIds) ||
      seen.has(c.key)
    )
      continue;
    const ids = [...new Set(c.evidenceIds)].filter((id) => typeof id === "string" && byId.has(id));
    if (!ids.length || ids.length !== new Set(c.evidenceIds).size) continue;
    const cited = ids.map((id) => byId.get(id)!).filter((o) => asChannel(o.channel));
    if (new Set(cited.map((o) => o.prospectKey)).size < 5) continue;
    seen.add(c.key);
    // Mixed evidence never grants permission to an unobserved drafting stage.
    for (const channel of ["email", "linkedin"] as const) {
      for (const stage of ["first_touch", "follow_up"] as const) {
        const evidence = cited.filter((o) => o.channel === channel && o.stage === stage);
        if (new Set(evidence.map((o) => o.prospectKey)).size < 5) continue;
        out.push({ key: c.key, instruction: c.instruction.trim(), channel, stage, evidence });
      }
    }
  }
  return out;
}

function replySamples(evidence: LearningObservation[]): LearningEvidenceSample[] {
  return evidence.slice(0, 5).map((o) => ({
    name: o.name,
    at: o.at,
    original: o.original,
    sent: o.body.slice(0, 1500),
    feedback: o.feedback,
    channel: o.channel,
    stage: "reply",
  }));
}

function draftSamples(evidence: DraftObservation[]): LearningEvidenceSample[] {
  return evidence.slice(0, 5).map((o) => ({
    at: o.closedAt ?? undefined,
    original: o.rejected.at(-1)?.body ?? null,
    sent: o.body.slice(0, 1500),
    channel: asChannel(o.channel) ?? undefined,
    stage: o.stage,
  }));
}

/** What one run knows when it decides whether a candidate becomes a proposal. */
export interface ProposeRun {
  /** Normalized instruction texts the founder said no to, in any area. */
  excluded: ReadonlySet<string>;
  /** Areas (`learningScopeKey`) that got a proposal this run: one each. */
  proposedAreas: Set<string>;
  /** The workspace's LinkedIn copy is templates: no LinkedIn draft reads learned guidance. */
  templatedLinkedIn: boolean;
  /** Evidence sends in the area after `since` (its last proposal or decision). */
  newSends(
    area: { channel: LearningChannel | null; stage: LearningStage; basis?: "replies" },
    since: string,
  ): number;
}

/**
 * Insert a scoped pending proposal, at most one per area per run, unless no
 * draft in the area would read it (templated LinkedIn copy), the area has
 * had fewer than `MIN_NEW_EVIDENCE_SENDS` new sends since its last proposal
 * or decision, the founder already said no to the text, or it rewords
 * (`nearDuplicateText`) a text the area already raised: pending, applied,
 * dismissed or retired. A proposal that passes supersedes the one waiting
 * in its area (`LearningStore.insert`).
 */
export function proposePreference(
  ledger: Ledger,
  input: {
    key: string;
    instruction: string;
    source: PreferenceCandidate["source"] | "outcome";
    channel: LearningChannel | null;
    stage: LearningStage;
    /** `replies`: a reply-rate result, in its own area beside the style one. */
    basis?: "replies";
    evidence: LearningEvidence;
    summary: string;
  },
  run: ProposeRun,
): "inserted" | "skipped" {
  const normalized = normalizeLearnedText(input.instruction);
  if (!normalized || run.excluded.has(normalized)) return "skipped";
  const scope = {
    ...(input.channel ? { channel: input.channel } : {}),
    stage: input.stage,
    ...(input.basis ? { basis: input.basis } : {}),
  };
  const area = learningScopeKey("preference", scope);
  if (run.proposedAreas.has(area)) return "skipped";
  if (run.templatedLinkedIn && (TEMPLATED_LINKEDIN_SCOPE_KEYS as readonly string[]).includes(area))
    return "skipped";
  const since = ledger.learning.preferenceAreaWatermark(area);
  if (
    since !== null &&
    run.newSends({ channel: input.channel, stage: input.stage, basis: input.basis }, since) <
      MIN_NEW_EVIDENCE_SENDS
  )
    return "skipped";
  const dedupeKey = `${input.channel ?? "any"}:${input.stage}:${input.basis ? `${input.basis}:` : ""}${normalized}`;
  if (ledger.learning.hasPendingDuplicate("preference", dedupeKey)) return "skipped";
  // An exact repeat of active guidance is the closest near-duplicate of all.
  if (
    nearDuplicateText(
      input.instruction,
      ledger.learning.preferenceTextsInArea({
        channel: input.channel,
        stage: input.stage,
        basis: input.basis,
      }),
    )
  )
    return "skipped";
  const view = ledger.learning.insert({
    kind: "preference",
    scope,
    current: null,
    proposed: { instruction: input.instruction, source: input.source, key: input.key },
    evidence: input.evidence,
    evidenceSummary: input.summary,
    baselineKey: "",
    dedupeKey,
  });
  if (!view) return "skipped";
  run.proposedAreas.add(area);
  return "inserted";
}

const describe = (channel: LearningChannel | null, stage: LearningStage | null) =>
  `${channel === "email" ? "email" : channel === "linkedin" ? "LinkedIn" : "email and LinkedIn"} ${
    stage === "first_touch"
      ? "first touches"
      : stage === "follow_up"
        ? "follow-ups"
        : stage === "reply"
          ? "replies"
          : "sends"
  }`;

/**
 * One-time: the v1 LinkedIn preferences this workspace learned before
 * approval existed become legacy proposals (enabled rows pending, disabled
 * rows dismissed, so they stay excluded). Evidence travels with them;
 * nothing is deleted. Marked done in `learning_jobs` so it never repeats.
 */
export function importLegacyPreferences(
  ledger: Ledger,
  learning: ReplyLearningStore,
  workspace: string,
  now = Date.now(),
): number {
  if (ledger.learning.jobState(LEGACY_JOB).refreshed_at) return 0;
  const token = ledger.learning.claimJob(LEGACY_JOB, now, { cooldownMs: 0, leaseMs: 60_000 });
  if (!token) return 0;
  let imported = 0;
  const excluded = new Set(ledger.learning.excludedPreferenceTexts());
  const dismissed = (p: { enabled: boolean; instruction: string }) =>
    !p.enabled || excluded.has(normalizeLearnedText(p.instruction));
  // One pending per area: each import supersedes the one before it, so the
  // rows dismissed on import go first and never push an enabled one out.
  const legacy = learning
    .legacyPreferences(workspace)
    .toSorted((a, b) => Number(dismissed(b)) - Number(dismissed(a)));
  for (const p of legacy) {
    const dedupeKey = normalizeLearnedText(p.instruction);
    const view = ledger.learning.insert({
      kind: "preference",
      scope: { channel: "linkedin", stage: "reply" },
      current: null,
      proposed: { instruction: p.instruction, source: p.source, key: p.id },
      evidence: {
        refs: p.evidence.map((o) => ({ type: "reply_send", id: o.id })),
        samples: replySamples(p.evidence),
        counts: { threads: new Set(p.evidence.map((o) => o.threadKey)).size },
        method: p.source,
      },
      evidenceSummary: `Learned from ${p.evidence.length} LinkedIn ${p.evidence.length === 1 ? "reply" : "replies"} before approval existed; ${
        p.enabled ? "was applied automatically until now" : "was disabled by you"
      }.`,
      baselineKey: "",
      dedupeKey,
      legacy: true,
    });
    if (!view) continue;
    imported++;
    if (dismissed(p)) ledger.learning.decide(view.id, "dismissed", new Date(now).toISOString());
  }
  ledger.learning.finishJob(LEGACY_JOB, token, { now: new Date(now).toISOString() });
  if (imported) logEvent("reply.learning.legacy_imported", { workspace, count: imported });
  return imported;
}

/** Scheduler-only synthesis: no drafting or sending path waits for an LLM. */
export async function refreshReplyLearning(): Promise<void> {
  if (demoMode()) return;
  const workspace = currentWorkspaceName();
  const learning = getReplyReviewStore().learning;
  const ledger = getLedger();
  const inbox = getLinkedInInboxStore();
  importLegacyPreferences(ledger, learning, workspace);
  const imported = learning.importHistory(workspace, (t) => {
    if (t.channel === "email") return t.workspace === workspace;
    if (!t.accountKey) return false;
    const account = inbox.account(t.accountKey);
    const record = inbox.thread(t.key);
    // Prior reassignment makes historical workspace ownership ambiguous.
    const reassigned = inbox.db
      .query("SELECT 1 FROM assignments WHERE thread_key=? LIMIT 1")
      .get(t.key);
    return (
      !!account &&
      record?.accountKey === t.accountKey &&
      record.owner?.workspace === workspace &&
      record.owner.prospectId === t.prospectId &&
      !reassigned
    );
  });
  if (imported) logEvent("reply.learning.imported", { workspace, count: imported });

  const now = Date.now();
  const job = learning.claim(workspace, now);
  // The workspace pause gates every kind of evidence, draft-side included:
  // a paused workspace must not spend or fill /queue from reviewed drafts.
  if (!learning.status(workspace).enabled) return;
  // Draft evidence has its own lease and watermark in the ledger; a run with
  // nothing new on either side releases immediately (the cooldown is spent,
  // which is the point of a cooldown).
  const draftToken = ledger.learning.claimJob(DRAFT_JOB, now, {
    cooldownMs: COOLDOWN_MS,
    leaseMs: LEASE_MS,
  });
  const drafts = draftToken
    ? ledger.learning.draftObservationsSince(ledger.learning.jobState(DRAFT_JOB).watermark, 100)
    : [];
  if (draftToken && drafts.length === 0) ledger.learning.finishJob(DRAFT_JOB, draftToken);
  const draftLease = draftToken && drafts.length > 0 ? draftToken : null;
  if (!job && !draftLease) return;

  let reservation: ReturnType<typeof tryReserveDailySpend> | undefined;
  // complete() includes provider retries and Retry-After delays; renew for its full lifetime.
  const heartbeat = setInterval(() => {
    try {
      const alive =
        (job ? learning.renew(workspace, job.token) : true) &&
        (draftLease ? ledger.learning.renewJob(DRAFT_JOB, draftLease, Date.now(), LEASE_MS) : true);
      if (!alive) clearInterval(heartbeat);
    } catch {
      logEvent("reply.learning.renew_failed", { workspace }, "warn");
    }
  }, 60_000);
  heartbeat.unref();
  const failAll = (reason: string) => {
    if (job) learning.fail(workspace, job.token, reason);
    if (draftLease) ledger.learning.failJob(DRAFT_JOB, draftLease, reason);
  };
  try {
    reservation = tryReserveDailySpend(2);
    if (!reservation.granted) {
      failAll("Learning paused by the daily spend limit; will retry.");
      logEvent("reply.learning.spend_capped", { workspace }, "warn");
      return;
    }
    const excluded = new Set(ledger.learning.excludedPreferenceTexts());
    const replyObservations = job?.observations ?? [];
    const run: ProposeRun = {
      excluded,
      proposedAreas: new Set(),
      templatedLinkedIn: linkedinWriterOf(loadConfig()) === "template",
      newSends: (area, since) =>
        area.stage === "reply"
          ? new Set(
              replyObservations
                .filter(
                  (o) =>
                    (area.channel === null || o.channel === area.channel) &&
                    Date.parse(o.at) > Date.parse(since),
                )
                .map((o) => o.id),
            ).size
          : area.channel
            ? ledger.learning.draftEvidenceSendsSince(area.channel, area.stage, since)
            : 0,
    };
    const guidance = ledger.learning.listGuidance(true).filter((g) => g.status !== "rolled_back");
    const response = await complete({
      messages: [
        { role: "system", content: learningStylePrompt() },
        {
          role: "user",
          content: JSON.stringify({
            approvedGuidance: guidance.map((g) => ({
              instruction: g.instruction,
              channel: g.channel,
              stage: g.stage,
              enabled: g.status === "enabled",
            })),
            excludedInstructions: [...excluded],
            observations: [
              ...(job?.observations ?? []).map((o) => ({
                id: o.id,
                channel: o.channel,
                stage: "reply",
                thread: o.threadKey,
                historical: o.historical,
                move: o.move,
                context: o.context ?? [],
                original: o.original?.slice(0, 1500) ?? null,
                sent: o.body.slice(0, 1500),
                feedback: o.feedback.map((f) => f.slice(0, 1000)),
              })),
              ...drafts.map((o) => ({
                id: draftId(o),
                channel: o.channel,
                stage: o.stage,
                thread: o.prospectKey,
                historical: false,
                move: null,
                context: [],
                original: null,
                rejectedDrafts: o.rejected.slice(-3).map((r) => r.body.slice(0, 1500)),
                sent: o.body.slice(0, 1500),
                feedback: [],
              })),
            ],
          }),
        },
      ],
      temperature: 0.2,
      maxTokens: 4000,
      timeoutMs: 90_000,
    });
    const parsed = tryParseJsonObject<{ preferences?: unknown }>(response.content, {});
    if (!Array.isArray(parsed.preferences)) throw new Error("Invalid learning response");
    const candidates = parsed.preferences as PreferenceCandidate[];

    let proposed = 0;
    let replyAccepted: AcceptedCandidate[] | null = [];
    if (job) {
      replyAccepted = learning.accept(
        workspace,
        job.token,
        job.through,
        candidates,
        job.observations,
      );
      if (replyAccepted === null) {
        // The founder changed a control mid-run or another process took over:
        // this run's evidence is stale; nothing is proposed from it.
        logEvent("reply.learning.stale_lease", { workspace }, "warn");
      } else {
        for (const c of replyAccepted) {
          const threads = new Set(c.evidence.map((o) => o.threadKey)).size;
          const result = proposePreference(
            ledger,
            {
              key: c.key,
              instruction: c.instruction,
              source: c.source,
              channel: c.channel,
              stage: "reply",
              evidence: {
                refs: c.evidence.map((o) => ({ type: "reply_send", id: o.id })),
                samples: replySamples(c.evidence),
                counts: { threads },
                method: c.source,
              },
              summary: `${
                c.source === "explicit"
                  ? "Your explicit feedback on"
                  : c.source === "edits"
                    ? "The same edit, made in"
                    : "A consistent pattern across"
              } ${threads} ${describe(c.channel, "reply")}.`,
            },
            run,
          );
          if (result === "inserted") proposed++;
        }
      }
    }
    // The pause may have landed while the model call was in flight: the reply
    // path's `accept` sees that through its lease; the draft path checks here,
    // before anything is inserted or its watermark moves.
    const draftAccepted =
      draftLease && !learning.status(workspace).enabled
        ? []
        : acceptDraftCandidates(candidates, drafts);
    if (draftLease && !learning.status(workspace).enabled) {
      ledger.learning.failJob(DRAFT_JOB, draftLease, "Learning paused mid-run; will retry.");
    }
    for (const c of draftAccepted) {
      const prospects = new Set(c.evidence.map((o) => o.prospectKey)).size;
      const result = proposePreference(
        ledger,
        {
          key: c.key,
          instruction: c.instruction,
          source: "style",
          channel: c.channel,
          stage: c.stage,
          evidence: {
            refs: c.evidence.map((o) => ({ type: "draft_version", id: o.id })),
            samples: draftSamples(c.evidence),
            counts: {
              prospects,
              rejectedDrafts: c.evidence.reduce((n, o) => n + o.rejected.length, 0),
            },
            method: "style",
          },
          summary: `What you sent, next to the drafts you regenerated, across ${prospects} ${describe(c.channel, c.stage)}.`,
        },
        run,
      );
      if (result === "inserted") proposed++;
    }
    // Proposals are in the ledger before either watermark moves: a crash here
    // replays the batch, and the pending-dedupe index absorbs the retry.
    const committed = job
      ? replyAccepted !== null && learning.finish(workspace, job.token, job.through)
      : true;
    if (draftLease && learning.status(workspace).enabled)
      ledger.learning.finishJob(DRAFT_JOB, draftLease, {
        // Only the new rows move the watermark; the older context rode along.
        watermark: Math.max(...drafts.filter((o) => o.isNew).map((o) => o.id)),
      });
    logEvent("reply.learning.refreshed", {
      workspace,
      observations: (job?.observations.length ?? 0) + drafts.length,
      proposed,
      committed,
    });
  } catch {
    // Model/provider errors can contain message text; keep it out of logs and UI.
    failAll("Could not refresh writing preferences; will retry.");
    logEvent("reply.learning.failed", { workspace }, "warn");
  } finally {
    clearInterval(heartbeat);
    if (reservation?.granted) reservation.release();
  }
}
