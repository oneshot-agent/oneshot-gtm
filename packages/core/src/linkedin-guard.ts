import { demoMode } from "./demo.ts";
import { logEvent } from "./events.ts";
import { getLedger } from "./ledger.ts";
import { getSharedDb, type LinkedInTouch, type SharedDb } from "./shared-db.ts";

/**
 * The guard every LinkedIn invite passes before it can leave. Email first
 * touches go through dedupe and safety checks; an invite is irreversible, so
 * it gets the same: a real personal profile, a name that is a person, no
 * opt-out, no engagement elsewhere, a passing ICP verdict, and a profile no
 * workspace (or earlier tool) has already invited. A refusal is recoverable
 * (fix the row and resend); a sent invite is not. When in doubt, refuse.
 */

export type LinkedInGuardReason =
  | "invalid-profile"
  | "not-a-person"
  | "opted-out"
  | "replied"
  | "cadence-stopped"
  | "icp-rejected"
  | "already-invited"
  | "already-touched"
  | "guard-unavailable";

export type LinkedInGuardVerdict =
  | { ok: true }
  | { ok: false; reason: LinkedInGuardReason; detail: string };

/** What the guard reads off a queue row or a cadence's prospect. */
export interface LinkedInInviteProspect {
  /** Known when the prospect is already in the ledger. */
  prospectId?: number | null;
  name?: string | null;
  company?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  /** The ICP verdict the row carries (a human override rewrites it to `pass`). */
  icpVerdict?: string | null;
}

/** What the guard needs from the ledger. `Ledger` satisfies it. */
export interface LinkedInGuardLedger {
  resolveProspectForLinkedInReply(input: {
    email?: string;
    linkedinUrl?: string;
  }): { status: "matched"; prospectId: number } | { status: "unmatched" } | { status: "conflict" };
  linkedInGuardFacts(prospectId: number): LinkedInGuardFacts | null;
}

/** What the guard needs from the shared DB. `SharedDb` satisfies it. */
export interface LinkedInGuardShared {
  linkedInTouch(slug: string): LinkedInTouch | null;
}

export interface LinkedInGuardContext {
  ledger: LinkedInGuardLedger;
  /** Defaults to the process-wide shared DB. */
  shared?: LinkedInGuardShared;
}

/** The ledger-side facts about one prospect (ledger-linkedin-guard.ts). */
export interface LinkedInGuardFacts {
  optedOut: boolean;
  /** A reply in `inbox_replies` that is not an out-of-office. */
  emailReply: boolean;
  /** A reply on any channel in `channel_events` (LinkedIn included). */
  channelReply: boolean;
  /** A cadence with status `stopped` or `unsubscribed`. */
  cadenceStopped: boolean;
  icpVerdict: string | null;
}

export interface NormalizedLinkedInProfile {
  /** `https://www.linkedin.com/in/<slug>`, percent-encoding exactly as stored. */
  url: string;
  /** The slug as stored. */
  slug: string;
  /** The dedupe key: the slug, lowercased. */
  key: string;
}

/**
 * A personal LinkedIn profile, normalised, or null for anything else (X and
 * GitHub URLs, company/school pages, `/pub/dir/`, other hosts).
 *
 * The slug's percent-encoding is kept as stored: decoding changes the identity
 * of slugs like `iskender-%E2%80%9Calex%E2%80%9D-tale-654849181`.
 */
export function normalizeLinkedInProfile(
  raw: string | null | undefined,
): NormalizedLinkedInProfile | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  // Query and hash are not part of `pathname`. A trailing locale (`/en`,
  // `/en-us`) is appended to shared profile links.
  const match = /^\/in\/([^/]+)(?:\/[a-z]{2}(?:[-_][a-z]{2})?)?\/?$/i.exec(url.pathname);
  const slug = match?.[1];
  if (!slug) return null;
  return {
    url: `https://www.linkedin.com/in/${slug}`,
    slug,
    key: slug.toLowerCase(),
  };
}

const ORG_WORDS = new Set([
  "inc",
  "llc",
  "ltd",
  "limited",
  "gmbh",
  "corp",
  "corporation",
  "labs",
  "lab",
  "software",
  "technologies",
  "technology",
  "solutions",
  "systems",
  "automation",
  "studio",
  "studios",
  "agency",
  "consulting",
  "group",
  "ventures",
  "capital",
  "bot",
  "agents",
]);

/** Lowercase, letters and digits only. */
function alnum(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Whether `name` reads as a person rather than a repo, handle or company.
 * Conservative on purpose: a miss is a recoverable skip, a wrong invite isn't.
 */
export function looksLikePersonName(
  name: string | null | undefined,
  opts: { company?: string | null; email?: string | null } = {},
): boolean {
  const trimmed = (name ?? "").trim();
  if (trimmed.length < 2) return false;
  if (/\d/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1 && /[-_./]/.test(trimmed)) return false;
  for (const token of tokens) {
    const word = token.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (ORG_WORDS.has(word)) return false;
  }
  // A single token that the company echoes is the company's own name, unless
  // the mailbox is that person's (local part, never the domain). Multi-token
  // names skip this: real people often have their handle in `company`.
  if (tokens.length === 1) {
    const me = alnum(trimmed);
    const company = alnum(opts.company ?? "");
    if (me && company && (company === me || company.includes(me))) {
      const local = alnum((opts.email ?? "").split("@")[0] ?? "");
      if (!local.includes(me)) return false;
    }
  }
  return true;
}

function refuse(reason: LinkedInGuardReason, detail: string): LinkedInGuardVerdict {
  return { ok: false, reason, detail };
}

/**
 * May this prospect be invited on LinkedIn? Read-only: the authoritative
 * one-profile-one-invite claim is `claimLinkedInProfile` at send time; this
 * verdict is what drain, /queue and /cadences show beforehand.
 */
export function canInviteOnLinkedIn(
  prospect: LinkedInInviteProspect,
  ctx: LinkedInGuardContext,
): LinkedInGuardVerdict {
  // 1. Profile URL.
  const profile = normalizeLinkedInProfile(prospect.linkedinUrl);
  if (!profile) {
    return refuse(
      "invalid-profile",
      "the LinkedIn URL is not a personal profile (linkedin.com/in/<name>)",
    );
  }

  // 2. Looks like a person.
  if (!looksLikePersonName(prospect.name, { company: prospect.company, email: prospect.email })) {
    return refuse(
      "not-a-person",
      `"${(prospect.name ?? "").trim()}" doesn't look like a person's name`,
    );
  }

  // 3-5. Ledger facts, for a prospect we already know.
  let icpVerdict = prospect.icpVerdict ?? null;
  try {
    let prospectId = prospect.prospectId ?? null;
    if (prospectId == null) {
      const found = ctx.ledger.resolveProspectForLinkedInReply({
        ...(prospect.email ? { email: prospect.email } : {}),
        linkedinUrl: profile.url,
      });
      if (found.status === "conflict") {
        return refuse("guard-unavailable", "this profile matches more than one prospect");
      }
      if (found.status === "matched") prospectId = found.prospectId;
    }
    const facts = prospectId != null ? ctx.ledger.linkedInGuardFacts(prospectId) : null;
    if (facts) {
      if (facts.optedOut) return refuse("opted-out", "they opted out of contact");
      if (facts.emailReply || facts.channelReply) {
        return refuse("replied", "they already replied");
      }
      if (facts.cadenceStopped) {
        return refuse("cadence-stopped", "their cadence was stopped or they unsubscribed");
      }
      // A human override on the row (verdict rewritten to `pass`) wins over
      // the stored machine verdict; NULL passes.
      icpVerdict = icpVerdict ?? facts.icpVerdict;
    }
  } catch (err) {
    return refuse("guard-unavailable", `could not check the ledger: ${(err as Error).message}`);
  }

  // 5. ICP.
  if (icpVerdict === "reject") {
    return refuse("icp-rejected", "the ICP gate rejected this person");
  }

  // 6-7. One profile, one invite; the suppression list.
  try {
    const held = (ctx.shared ?? getSharedDb()).linkedInTouch(profile.key);
    if (held) return refuse(...touchedReason(held));
  } catch (err) {
    logEvent(
      "shared_db.read_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return refuse("guard-unavailable", "the shared invite record is unreadable");
  }
  return { ok: true };
}

function touchedReason(held: LinkedInTouch): [LinkedInGuardReason, string] {
  if (held.source.startsWith("invite:")) {
    const who = held.source.slice("invite:".length);
    return [
      "already-invited",
      held.status === "reserved"
        ? `an invite to this profile is being sent by workspace '${who}'`
        : `workspace '${who}' already invited this profile`,
    ];
  }
  return ["already-touched", `already touched elsewhere (${held.source})`];
}

/** `reason: detail`: the flag a refused row or step carries, parsed by `guardReasonOfFlag`. */
export function guardFlag(v: Extract<LinkedInGuardVerdict, { ok: false }>): string {
  return `${v.reason}: ${v.detail}`;
}

const GUARD_REASONS: ReadonlySet<string> = new Set([
  "invalid-profile",
  "not-a-person",
  "opted-out",
  "replied",
  "cadence-stopped",
  "icp-rejected",
  "already-invited",
  "already-touched",
  "guard-unavailable",
]);

/** The guard reason a flag carries, or null for any other flag. */
export function guardReasonOfFlag(flag: string): LinkedInGuardReason | null {
  const code = flag.split(":")[0]!.trim();
  return GUARD_REASONS.has(code) ? (code as LinkedInGuardReason) : null;
}

/** `not-a-person 3 · already-invited 2` */
export function describeGuardCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason} ${n}`)
    .join(" · ");
}

export interface LinkedInProfileClaim {
  /** The invite was accepted: the profile stays recorded for good. */
  confirm: () => void;
  /** The invite did not go out: free the profile. */
  release: () => void;
}

type ProfileClaimStore = Pick<
  SharedDb,
  "claimLinkedInProfile" | "confirmLinkedInProfile" | "releaseLinkedInProfile"
>;

/**
 * Reserve a profile in the shared DB before the invite call (the same
 * reserve-before-await pattern as the quota), so two workspaces sharing one
 * account can't both invite it. Refused when another claim or an earlier
 * invite holds it, and when the shared file can't be used: an unrecorded
 * invite could go out twice, a refused one can be retried.
 */
export function claimLinkedInProfile(input: {
  profile: NormalizedLinkedInProfile;
  workspace: string;
  shared?: ProfileClaimStore;
}): { ok: true; claim: LinkedInProfileClaim } | Extract<LinkedInGuardVerdict, { ok: false }> {
  if (demoMode()) return { ok: true, claim: { confirm: () => {}, release: () => {} } };
  const warn = (err: unknown): void =>
    logEvent(
      "shared_db.write_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
  try {
    const db = input.shared ?? getSharedDb();
    const res = db.claimLinkedInProfile({
      slug: input.profile.key,
      source: `invite:${input.workspace}`,
    });
    if ("held" in res) {
      const [reason, detail] = touchedReason(res.held);
      return { ok: false, reason, detail };
    }
    const settle = (fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        warn(err);
      }
    };
    return {
      ok: true,
      claim: {
        confirm: () => settle(() => db.confirmLinkedInProfile(res.id)),
        release: () => settle(() => db.releaseLinkedInProfile(res.id)),
      },
    };
  } catch (err) {
    warn(err);
    return {
      ok: false,
      reason: "guard-unavailable",
      detail: "the shared invite record is unavailable",
    };
  }
}

/** The guard against the process-wide ledger and shared DB. */
export function canInviteOnLinkedInNow(prospect: LinkedInInviteProspect): LinkedInGuardVerdict {
  return canInviteOnLinkedIn(prospect, { ledger: getLedger() });
}
