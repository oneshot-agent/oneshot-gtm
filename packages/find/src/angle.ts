import {
  getLedger,
  hasDossierSignal,
  loadConfig,
  logEvent,
  parseProspectAngle,
  type ProspectAngle,
  webRead,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import {
  fetchFollowNetwork,
  fetchGitHubOrgProfile,
  fetchGitHubOrgs,
  fetchGitHubUser,
  fetchTopRepos,
  type GitHubFollowNetwork,
  type GitHubOrgProfile,
  type GitHubOrgRef,
  type GitHubUserInfo,
  ownerFromRepoUrl,
  type TopRepo,
} from "./_github-user.ts";
import { safeDeepResearchPerson } from "./_sdk-safe.ts";
import { researchUrl } from "./_profile-url.ts";

/**
 * Evidence gathering + LLM synthesis for the per-prospect angle (issue #355).
 *
 * Every high-quality reply comes from the same loop — pull the prospect,
 * fetch their live public work, read what they actually replied, synthesize
 * one sharp evidence-grounded angle — and today that synthesis is discarded
 * every time. This assembles the inputs and calls the LLM once, so the
 * result can be persisted onto `prospects.angle_json`
 * (`Ledger.setProspectAngle`) and reused by drafting (#356) instead of
 * re-walking the same six lookups by hand.
 */

/** Bound each free-text evidence block so the synthesis prompt stays sized. */
const DOSSIER_SLICE = 5000;
const WEBREAD_SLICE = 3000;
const REPLY_BODY_SLICE = 1200;
const MAX_REPLIES = 6;

export interface AngleGitHubEvidence {
  login: string;
  profile: GitHubUserInfo | null;
  topRepos: TopRepo[] | null;
  orgs: GitHubOrgRef[] | null;
  /** The first org's own profile (bio + repo count) — what tells a one-month
   *  student lab apart from a funded company of the same shape. */
  linkedOrg: GitHubOrgProfile | null;
  network: GitHubFollowNetwork | null;
}

export interface AngleReplyEvidence {
  body: string;
  subject: string | null;
  receivedAt: string;
}

/** Everything gathered about one prospect, before the LLM sees any of it. */
export interface AngleEvidenceBundle {
  /** Free Tier-1 dossier text, else a freshly bought one — bounded. */
  dossierText: string | null;
  /** True when a paid `deepResearchPerson` call actually ran (not cached/free). */
  dossierResearched: boolean;
  /** The finder's original signal that queued this prospect, if any — bounded JSON text. */
  queueSignal: string | null;
  github: AngleGitHubEvidence | null;
  /** First-party page text for a non-GitHub profile URL (LinkedIn/X/Luma etc). */
  webReadText: string | null;
  /** True when a paid `webRead` call actually ran. */
  webReadResearched: boolean;
  replies: AngleReplyEvidence[];
  /** Paid spend this gather incurred (deepResearchPerson + webRead only — GitHub reads are free). */
  costUsd: number;
  /** Which tiers actually contributed evidence, e.g. ["dossier", "github:live", "replies:3"]. */
  sources: string[];
}

/**
 * Fetch every GitHub signal for one login, fanned out in parallel rather than
 * sequentially — the six-lookups-by-hand problem this issue exists to close.
 * `orgs` resolves first among the independent calls; `linkedOrg` is a genuine
 * dependency on its result (GitHub has no single endpoint for "the org's own
 * profile, keyed by user"), so it fires once `orgs` is known and stays the
 * only sequential hop.
 */
async function gatherGitHubEvidence(login: string): Promise<AngleGitHubEvidence> {
  const [profile, topRepos, orgs, network] = await Promise.all([
    fetchGitHubUser(login),
    fetchTopRepos(login),
    fetchGitHubOrgs(login),
    fetchFollowNetwork(login),
  ]);
  const firstOrg = orgs?.[0]?.login ?? null;
  const linkedOrg = firstOrg ? await fetchGitHubOrgProfile(firstOrg) : null;
  return { login, profile, topRepos, orgs, linkedOrg, network };
}

export interface GatherAngleEvidenceOpts {
  /**
   * Allow a paid `deepResearchPerson` / `webRead` call when nothing free is
   * available. Default true. `--dry-run` callers pass false so estimating a
   * backfill spends nothing.
   */
  allowPaidResearch?: boolean;
}

/**
 * Assemble every input the synthesis prompt needs for one prospect. Returns
 * null when the prospect doesn't exist. Best-effort throughout — a failure in
 * any one tier degrades that tier to empty rather than aborting the gather;
 * the LLM synthesis step decides what it can honestly say from what's left.
 */
export async function gatherAngleEvidence(
  prospectId: number,
  opts: GatherAngleEvidenceOpts = {},
): Promise<AngleEvidenceBundle | null> {
  const ledger = getLedger();
  const prospect = ledger.getProspectById(prospectId);
  if (!prospect) return null;
  const allowPaidResearch = opts.allowPaidResearch ?? true;

  const sources: string[] = [];
  let costUsd = 0;

  // Tier 1: the dossier we already own; buy one only when nothing free exists.
  let dossierText: string | null = null;
  let dossierResearched = false;
  const stored = prospect.dossier_json;
  if (stored?.trim() && hasDossierSignal(stored)) {
    dossierText = stored.slice(0, DOSSIER_SLICE);
    sources.push("dossier");
  } else if (allowPaidResearch) {
    const url = researchUrl(prospect);
    const email = prospect.email?.trim();
    if (url || email) {
      const res = await safeDeepResearchPerson(
        {
          ...(url ? { socialMediaUrl: url } : {}),
          ...(email ? { email } : {}),
          ...(prospect.name ? { name: prospect.name } : {}),
          ...(prospect.company && prospect.company !== "(unknown)"
            ? { company: prospect.company }
            : {}),
        },
        {
          playName: "synthesize-angles",
          memo: `gather angle evidence for prospect ${prospectId}`,
          decisionContext: { source: "angle.gather", prospectId },
        },
      );
      const billed = res.receiptId !== 0;
      if (billed) costUsd += res.result?.cost ?? 0;
      const payload = res.result?.result;
      if (res.result?.status !== "failed" && hasDossierSignal(payload)) {
        dossierText = JSON.stringify(payload, null, 2).slice(0, DOSSIER_SLICE);
        dossierResearched = billed;
        sources.push("dossier:live");
      }
    }
  }

  // The finder's original signal — why this prospect was queued in the first place.
  const queueRow = ledger.getQueueRowForProspect(prospectId);
  const queueSignal = queueRow ? queueRow.payload_json.slice(0, DOSSIER_SLICE) : null;

  // Live GitHub, when the profile URL points there; otherwise a bounded
  // first-party read of whatever profile URL we do have.
  let github: AngleGitHubEvidence | null = null;
  let webReadText: string | null = null;
  let webReadResearched = false;
  const profileUrl = researchUrl(prospect);
  const githubOwner = profileUrl ? ownerFromRepoUrl(profileUrl) : null;
  if (githubOwner) {
    github = await gatherGitHubEvidence(githubOwner);
    sources.push("github:live");
  } else if (profileUrl && allowPaidResearch) {
    try {
      const read = await webRead(
        { url: profileUrl },
        {
          playName: "synthesize-angles",
          memo: `read prospect's profile before synthesizing an angle`,
          decisionContext: { source: "angle.gather", prospectId, url: profileUrl },
        },
      );
      // Cost is billed the moment the call completes (a receipt is recorded
      // for it), independent of whether the markdown it returned was usable —
      // mirrors the dossier tier above, which adds `billed` cost before
      // checking `hasDossierSignal`. Gating this on `text` truthiness let a
      // billed-but-empty webRead run silently uncounted against
      // `--max-cost-usd`.
      costUsd += (read.result as unknown as { cost?: number }).cost ?? 0;
      const text = (read.result.markdown ?? "").trim().slice(0, WEBREAD_SLICE);
      if (text) {
        webReadText = text;
        webReadResearched = true;
        sources.push("webread");
      }
    } catch (err) {
      logEvent(
        "angle.gather.webread_failed",
        { prospectId, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
    }
  }

  // Reply history — the prospect's own corrections outrank any inferred signal.
  // Includes both inbox (email) replies and LinkedIn channel_events replies
  // (recordLinkedInReply) — a prospect who only ever replied on LinkedIn must
  // not have that reply invisible to synthesis (finding PRRT_kwDOSKzrBs6gUX7P).
  const emailReplies: AngleReplyEvidence[] = ledger
    .listInboxRepliesForProspect(prospectId)
    .map((r) => ({
      body: r.body,
      subject: r.subject,
      receivedAt: r.received_at,
    }));
  const linkedinReplies: AngleReplyEvidence[] = ledger
    .listChannelEventsForProspect(prospectId)
    .filter((e) => e.event_type === "reply" && e.body?.trim())
    .map((e) => ({
      body: e.body as string,
      subject: `(${e.channel} reply)`,
      receivedAt: e.occurred_at,
    }));
  const replies: AngleReplyEvidence[] = [...emailReplies, ...linkedinReplies]
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .slice(-MAX_REPLIES)
    .map((r) => ({ ...r, body: r.body.slice(0, REPLY_BODY_SLICE) }));
  if (replies.length > 0) sources.push(`replies:${replies.length}`);

  return {
    dossierText,
    dossierResearched,
    queueSignal,
    github,
    webReadText,
    webReadResearched,
    replies,
    costUsd,
    sources,
  };
}

/**
 * Render one GitHub evidence bundle into prompt-sized prose.
 *
 * Each entity carries its own `https://github.com/...` URL alongside its
 * bare name/login — the LLM's `evidence[].source` schema (and the prompt's
 * own example) shows a per-repo/per-profile URL like
 * `https://github.com/ada/agent-loop`, and `isGroundedSource`
 * (packages/core/src/angle.ts) only grounds a URL-shaped source when it
 * appears literally in this rendered text. Without the URL here, a genuine,
 * non-fabricated GitHub citation could never pass grounding — only the
 * coarse `"github:live"` tier tag could.
 */
function renderGitHubEvidence(gh: AngleGitHubEvidence): string {
  const profileUrl = `https://github.com/${gh.login}`;
  const lines: string[] = [`GITHUB (@${gh.login}, ${profileUrl}):`];
  if (gh.profile) {
    const p = gh.profile;
    lines.push(
      `Profile: ${p.name ?? gh.login}${p.company ? ` @ ${p.company}` : ""}` +
        `${p.blogDomain ? ` (${p.blogDomain})` : ""}` +
        `${p.createdAt ? ` — account created ${p.createdAt}` : ""}` +
        ` — ${p.publicRepos} public repos, ${p.followers} followers`,
    );
  }
  if (gh.topRepos && gh.topRepos.length > 0) {
    lines.push("Recent repos:");
    for (const r of gh.topRepos.slice(0, 5)) {
      lines.push(
        `- ${r.name} (${profileUrl}/${r.name})${r.language ? ` [${r.language}]` : ""}: ` +
          `${r.description ?? "(no description)"}`,
      );
    }
  }
  if (gh.orgs && gh.orgs.length > 0) {
    lines.push(
      `Orgs: ${gh.orgs.map((o) => `${o.login} (https://github.com/${o.login})`).join(", ")}`,
    );
  }
  if (gh.linkedOrg) {
    const orgUrl = `https://github.com/${gh.linkedOrg.login}`;
    lines.push(
      `Linked org @${gh.linkedOrg.login} (${orgUrl}): ${gh.linkedOrg.name ?? gh.linkedOrg.login}` +
        `${gh.linkedOrg.description ? ` — ${gh.linkedOrg.description}` : ""}` +
        ` (${gh.linkedOrg.publicRepos} public repos` +
        `${gh.linkedOrg.createdAt ? `, created ${gh.linkedOrg.createdAt}` : ""})`,
    );
  }
  if (gh.network && (gh.network.following.length > 0 || gh.network.followers.length > 0)) {
    lines.push(
      `Network: follows ${gh.network.following.length}, followed by ${gh.network.followers.length}`,
    );
  }
  return lines.join("\n");
}

function renderEvidenceForPrompt(evidence: AngleEvidenceBundle): string {
  const blocks: string[] = [];
  if (evidence.dossierText) blocks.push(`DOSSIER:\n${evidence.dossierText}`);
  if (evidence.queueSignal)
    blocks.push(`FINDER SIGNAL (why they were queued):\n${evidence.queueSignal}`);
  if (evidence.github) blocks.push(renderGitHubEvidence(evidence.github));
  if (evidence.webReadText) blocks.push(`PROFILE PAGE:\n${evidence.webReadText}`);
  if (evidence.replies.length > 0) {
    const replyLines = evidence.replies.map(
      (r, i) => `[${i + 1}] ${r.receivedAt}${r.subject ? ` — ${r.subject}` : ""}\n${r.body}`,
    );
    blocks.push(`REPLY HISTORY (oldest to newest):\n${replyLines.join("\n\n")}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n---\n\n") : "(no evidence found for this prospect)";
}

export interface SynthesizePersonAngleInput {
  prospect: {
    id: number;
    name: string | null;
    company: string | null;
    email: string | null;
  };
  evidence: AngleEvidenceBundle;
}

export interface SynthesizePersonAngleResult {
  angle: ProspectAngle | null;
  /** LLM completions aren't billed through OneShot receipts (BYO key) — this
   *  is always 0 today, kept for symmetry with the evidence-gather cost and
   *  so a future per-token cost estimate has somewhere to report through. */
  costUsd: number;
}

/**
 * Synthesize one evidence-grounded angle from an already-gathered evidence
 * bundle. Idiom mirrors `add-prospect.ts`'s extract step: `loadPrompt` +
 * `complete` + `tryParseJsonObject`, then `parseProspectAngle` enforces the
 * anti-fabrication contract (uncited evidence dropped, enums sanitized).
 */
export async function synthesizePersonAngle(
  input: SynthesizePersonAngleInput,
): Promise<SynthesizePersonAngleResult> {
  const cfg = loadConfig();
  const evidenceText = renderEvidenceForPrompt(input.evidence);
  const userMessage = [
    `FOUNDER: ${cfg.founderName ?? "(unknown)"}`,
    `PRODUCT: ${cfg.productOneLiner ?? "(not set)"}`,
    `ICP: ${cfg.icpOneLiner ?? "(not set)"}`,
    ...(cfg.founderCredentials ? [`FOUNDER CREDENTIALS: ${cfg.founderCredentials}`] : []),
    ...(cfg.productPortfolio ? [`PRODUCT PORTFOLIO: ${cfg.productPortfolio}`] : []),
    ...(cfg.founderAdmission ? [`FOUNDER ADMISSION: ${cfg.founderAdmission}`] : []),
    "",
    `PROSPECT: ${input.prospect.name ?? "(unknown)"}` +
      `${input.prospect.company ? ` @ ${input.prospect.company}` : ""}` +
      `${input.prospect.email ? ` <${input.prospect.email}>` : ""}`,
    "",
    evidenceText,
  ].join("\n");

  let res: Awaited<ReturnType<typeof complete>>;
  try {
    res = await complete({
      messages: [
        { role: "system", content: loadPrompt("angle-synthesis") },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      maxTokens: 900,
    });
  } catch (err) {
    logEvent(
      "angle.synthesize.llm_failed",
      { prospectId: input.prospect.id, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return { angle: null, costUsd: 0 };
  }

  const raw = tryParseJsonObject<Record<string, unknown>>(res.content, {});
  const angle = parseProspectAngle(
    raw,
    { model: `${res.provider}/${res.model}` },
    {
      evidenceText,
      sourceTags: input.evidence.sources,
    },
  );
  return { angle, costUsd: 0 };
}
