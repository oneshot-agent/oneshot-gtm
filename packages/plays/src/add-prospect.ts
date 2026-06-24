import { deepResearchPerson, getLedger, loadConfig } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { type ProfileIntroTarget, runProfileIntro } from "./profile-intro.ts";

const PLAY_NAME = "profile-intro";

/** Transient note on a placeholder row while its background research runs. */
const RESEARCHING_NOTE = "researching profile…";

export type Platform = "linkedin" | "twitter" | "github";

/** Validated, normalized profile URL + which platform it points at. */
export interface ParsedProfileUrl {
  platform: Platform;
  /** The original URL, trimmed. */
  url: string;
  /** Stable `host/path` key for queue dedupe (lowercased, no query/trailing slash). */
  dedupeKey: string;
}

/**
 * Validate a pasted profile URL and classify the platform. Throws on an
 * unparseable URL or an unsupported host — `deepResearchPerson` chases
 * LinkedIn / X-Twitter / GitHub social URLs, so we gate to those.
 */
export function parseProfileUrl(raw: string): ParsedProfileUrl {
  const trimmed = (raw ?? "").trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error("not a valid URL — paste a full LinkedIn or X/Twitter profile link");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("URL must be http(s)");
  }
  // Match the registrable domain exactly or as a dotted subdomain — NOT a bare
  // `endsWith("linkedin.com")`, which also matches `evillinkedin.com` (CodeQL:
  // incomplete URL substring sanitization).
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const hostMatches = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
  let platform: Platform;
  if (hostMatches("linkedin.com")) platform = "linkedin";
  else if (hostMatches("x.com") || hostMatches("twitter.com")) platform = "twitter";
  else if (hostMatches("github.com")) platform = "github";
  else throw new Error("unsupported URL — use a LinkedIn, X/Twitter, or GitHub profile");

  // Lowercase the path too: profile handles are case-insensitive, so
  // /in/JohnDoe and /in/johndoe are the same person and must dedupe to one key.
  const path = u.pathname.toLowerCase().replace(/\/+$/, "");
  return { platform, url: trimmed, dedupeKey: `${host}${path}` };
}

interface PlaceholderPayload {
  url: string;
  platform: Platform;
  emailOverride?: string;
}

export type CreateJobResult = { queueId: number } | { duplicate: true };

/**
 * Fast, synchronous step of the manual add-prospect flow: validate the URL and
 * enqueue a placeholder `profile-intro` queue row immediately (so it shows on
 * /queue right away), returning its id. The heavy dossier research + draft runs
 * separately in `runProspectResearch`. Returns `{ duplicate:true }` when this
 * profile is already queued for this play.
 */
export function createProspectResearchJob(input: {
  url: string;
  emailOverride?: string;
}): CreateJobResult {
  const parsed = parseProfileUrl(input.url);
  const ledger = getLedger();
  const payload: PlaceholderPayload = {
    url: parsed.url,
    platform: parsed.platform,
    ...(input.emailOverride ? { emailOverride: input.emailOverride } : {}),
  };
  const id = ledger.enqueueTarget({
    playName: PLAY_NAME,
    payload,
    dedupeKey: parsed.dedupeKey,
    source: "manual",
    notes: RESEARCHING_NOTE,
  });
  if (id != null) return { queueId: id };

  // Already queued under (profile-intro, dedupeKey). If the prior attempt never
  // produced a draft — research failed, or is still in flight — reuse that row
  // so a re-add RETRIES instead of being blocked forever by the unique index.
  // A row that already has a draft (or was sent) is a genuine duplicate.
  const existing = ledger.getQueueRowByDedupe(PLAY_NAME, parsed.dedupeKey);
  if (
    existing &&
    existing.last_draft_json == null &&
    existing.send_started_at == null &&
    existing.status !== "sent"
  ) {
    ledger.setQueueStatus({ id: existing.id, status: "pending" });
    ledger.updateQueuePayload({ id: existing.id, payload });
    ledger.setQueueNotes({ id: existing.id, notes: RESEARCHING_NOTE });
    return { queueId: existing.id };
  }
  return { duplicate: true };
}

interface ExtractResult {
  name?: string | null;
  company?: string | null;
  role?: string | null;
  email?: string | null;
  angle?: string | null;
  icpFit?: "strong" | "weak" | "none" | null;
  reasoning?: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Async step: research the profile via the OneShot SDK (`deepResearchPerson`,
 * which accepts any social URL — LinkedIn / X / GitHub — and returns a
 * multi-source dossier incl. work/personal emails), have the LLM extract
 * identity + an ICP-grounded angle, draft the intro via the profile-intro play
 * (dry-run, no send), then persist the full target + draft onto the queue row.
 * Never throws — failures are written to the row's notes so the founder sees
 * what happened. Safe to call as `void runProspectResearch(id)`.
 */
export async function runProspectResearch(queueId: number): Promise<void> {
  const ledger = getLedger();
  try {
    const row = ledger.getQueueRow(queueId);
    if (!row) return;
    let payload: PlaceholderPayload;
    try {
      payload = JSON.parse(row.payload_json) as PlaceholderPayload;
    } catch {
      ledger.setQueueNotes({ id: queueId, notes: "research failed: corrupt job payload" });
      return;
    }

    // 1. Research the person from their social URL.
    const research = await deepResearchPerson(
      {
        socialMediaUrl: payload.url,
        ...(payload.emailOverride ? { email: payload.emailOverride } : {}),
      },
      { playName: PLAY_NAME, decisionContext: { source: "add-prospect", url: payload.url } },
    );
    const enrichment = (research.result?.result?.enrichment ?? {}) as Record<string, unknown>;
    const articles = research.result?.result?.articles;
    // Research came back empty (bad/private URL, no match). Don't draft from
    // nothing — a fabricated intro is exactly what we're avoiding. Leave the
    // row note so the founder can fix the URL and re-add (which retries).
    const hasSignal =
      Object.keys(enrichment).length > 0 || (Array.isArray(articles) && articles.length > 0);
    if (!hasSignal) {
      ledger.setQueueNotes({
        id: queueId,
        notes: "couldn't research this profile — verify the URL is a public LinkedIn/X profile",
      });
      return;
    }
    const dossier = JSON.stringify(research.result?.result ?? research.result, null, 2).slice(
      0,
      6000,
    );

    // 2. Extract identity + ICP-grounded angle.
    const cfg = loadConfig();
    const extractSystem = loadPrompt("profile-extract");
    const extractUser = [
      `ICP: ${cfg.icpOneLiner ?? "(not set)"}`,
      `PRODUCT: ${cfg.productOneLiner ?? "(not set)"}`,
      `DOSSIER:\n${dossier}`,
    ].join("\n");
    const extractRes = await complete({
      messages: [
        { role: "system", content: extractSystem },
        { role: "user", content: extractUser },
      ],
      temperature: 0.3,
      maxTokens: 500,
    });
    const extracted = tryParseJsonObject<ExtractResult>(extractRes.content, {});

    // 3. Resolve the email: explicit override → extracted → SDK-found work/personal/alt.
    const altEmails = Array.isArray(enrichment["altemails"])
      ? (enrichment["altemails"] as unknown[]).map(str).filter((x): x is string => x != null)
      : [];
    const email =
      str(payload.emailOverride) ??
      str(extracted.email) ??
      str(enrichment["best_work_email"]) ??
      str(enrichment["best_personal_email"]) ??
      altEmails[0] ??
      null;

    // Store the URL under the field matching its platform — a GitHub URL must
    // NOT land in `linkedinUrl` (downstream enrichment treats that as LinkedIn).
    const urlField: Pick<ProfileIntroTarget, "linkedinUrl" | "twitterUrl" | "githubUrl"> =
      payload.platform === "twitter"
        ? { twitterUrl: payload.url }
        : payload.platform === "github"
          ? { githubUrl: payload.url }
          : { linkedinUrl: payload.url };
    const target: ProfileIntroTarget = {
      name: str(extracted.name) ?? str(enrichment["displayname"]) ?? "(unknown)",
      email,
      company: str(extracted.company),
      angle: str(extracted.angle),
      dossier,
      ...urlField,
    };

    // 4. Draft the intro (dry-run: prepare→draft→lint, never sends).
    const { drafted } = await runProfileIntro({ dryRun: true, targets: [target] });
    const draft = drafted[0];
    // runEmailPlay never throws per-target: an LLM/provider failure comes back
    // as an errorDraft ({subject:"(error)", body:"", flags:["error: …"]}), and a
    // malformed LLM response yields an empty subject/body. Treat either as a
    // failed draft — leave the note set (so a re-add retries) instead of
    // persisting a broken "(error)"/blank draft that would look ready to send.
    const errorFlag = draft?.flags.find((f) => f.startsWith("error:"));
    if (!draft || errorFlag || draft.subject.trim() === "" || draft.body.trim() === "") {
      ledger.setQueueNotes({
        id: queueId,
        notes: (errorFlag
          ? `draft failed: ${errorFlag}`
          : "draft came back empty — re-add to retry"
        ).slice(0, 200),
      });
      return;
    }

    // 5. Persist — re-read first so a concurrent reject/send isn't clobbered.
    // Only an untouched placeholder (still pending/approved, not sending) gets
    // the draft; a row the founder rejected mid-research stays rejected.
    const fresh = ledger.getQueueRow(queueId);
    if (
      !fresh ||
      (fresh.status !== "pending" && fresh.status !== "approved") ||
      fresh.send_started_at != null
    ) {
      return;
    }
    ledger.updateQueuePayload({ id: queueId, payload: target });
    ledger.setQueueDraft({
      id: queueId,
      draft: {
        subject: draft.subject,
        body: draft.body,
        flags: draft.flags,
        sent: false,
        receiptIds: [],
        dryRun: true,
      },
    });
    ledger.setQueueNotes({
      id: queueId,
      notes: email ? "" : "no email found — add an email before sending",
    });
  } catch (err) {
    try {
      ledger.setQueueNotes({
        id: queueId,
        notes: `research failed: ${(err as Error)?.message ?? "unknown error"}`.slice(0, 200),
      });
    } catch {
      // best-effort — the row simply keeps its "researching…" note
    }
  }
}
