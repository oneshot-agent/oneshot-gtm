import type {
  LinkedInFunnel,
  LinkedInInviteRow,
  LinkedInRate,
  LinkedInStepKind,
} from "@oneshot-gtm/shared-types";
import { getLedger, readLinkedInMeasure } from "@oneshot-gtm/core";
import { c, emitJson, header, note, setJsonMode } from "../output.ts";

export interface MeasureOptions {
  json?: boolean;
  sinceDays?: number;
  play?: string;
  stepKind?: string;
}

export interface LinkedInInvitesOptions {
  since?: string;
  status?: string;
  json?: boolean;
}

const STEP_KINDS = new Set<string>(["first-touch", "continuation"]);
const STATUSES = ["pending", "accepted", "withdrawn"] as const;
type InviteStatusFilter = (typeof STATUSES)[number];

function stepKindOf(value: string | undefined): LinkedInStepKind | undefined {
  if (value === undefined) return undefined;
  if (!STEP_KINDS.has(value)) throw new Error("--step-kind must be first-touch or continuation");
  return value as LinkedInStepKind;
}

const pct = (r: number | null): string => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
const ofRate = (r: LinkedInRate): string => `${r.count} of ${r.of} (${pct(r.rate)})`;

function renderFunnel(label: string, f: LinkedInFunnel): void {
  note(c.bold(label));
  note(`  invites sent                  ${f.invitesSent}`);
  note(`  pending                       ${f.pending}`);
  note(
    `  withdrawn                     ${f.withdrawn.total} (timeout ${f.withdrawn.timeout}, manual ${f.withdrawn.manual}, unrecorded ${f.withdrawn.unknown})`,
  );
  const days =
    f.accepted.medianDaysToAccept === null
      ? "n/a"
      : `${f.accepted.medianDaysToAccept} (over ${f.accepted.daysKnown})`;
  note(
    `  accepted                      ${f.accepted.total} (${pct(f.accepted.rate)}) · by invitation ${f.accepted.viaInvitation}, by conversation ${f.accepted.viaConversation}`,
  );
  note(`  median days to accept         ${days}`);
  note(`  already connected             ${f.alreadyConnected}`);
  note(`  first message sent            ${f.firstMessageSent}`);
  note(`  replied to the first message  ${ofRate(f.repliedToFirstMessage)}`);
  note(`  replied at any point          ${ofRate(f.repliedAtAnyPoint)}`);
  if (f.repliesMerged > 0) note(`  replies recorded twice, counted once: ${f.repliesMerged}`);
}

/**
 * `measure`: this workspace's sends by play and its LinkedIn funnel
 * (#792). Read-only. `--json` is `{ events, linkedin }`.
 */
export async function commandMeasure(opts: MeasureOptions = {}): Promise<void> {
  if (opts.json) setJsonMode(true);
  const stepKind = stepKindOf(opts.stepKind);
  const sinceDays = opts.sinceDays;
  if (sinceDays !== undefined && (!Number.isFinite(sinceDays) || sinceDays <= 0)) {
    throw new Error("--since-days must be a positive number");
  }
  const sinceIso =
    sinceDays !== undefined ? new Date(Date.now() - sinceDays * 86_400_000).toISOString() : null;
  const events = getLedger()
    .eventsByPlay(sinceIso ? { sinceIso } : {})
    .map((r) => ({
      playName: r.play_name,
      sent: r.sent,
      delivered: r.delivered,
      replied: r.replied,
      bounced: r.bounced,
    }));
  const { view } = readLinkedInMeasure({
    ...(sinceDays !== undefined ? { sinceDays } : {}),
    ...(opts.play ? { play: opts.play } : {}),
    ...(stepKind ? { stepKind } : {}),
  });
  if (opts.json) {
    await emitJson({ command: "measure", events, linkedin: view });
    return;
  }
  header("measure");
  note(c.bold("sends by play, every channel"));
  if (events.length === 0) note("  no sends yet");
  for (const e of events) {
    note(
      `  ${e.playName.padEnd(28)} sent ${e.sent} · delivered ${e.delivered} · replied ${e.replied} · bounced ${e.bounced}`,
    );
  }
  note("");
  header(`measure · linkedin · ${view.workspace}`);
  const filters = [
    view.filters.sinceDays !== null ? `last ${view.filters.sinceDays}d` : null,
    view.filters.play ? `play ${view.filters.play}` : null,
    view.filters.stepKind ? view.filters.stepKind : null,
  ].filter((f): f is string => f !== null);
  if (filters.length > 0) note(c.dim(`filters: ${filters.join(" · ")}`));
  if (view.funnel.invitesSent === 0) {
    note("No LinkedIn invites sent in this view.");
    return;
  }
  renderFunnel("all invites", view.funnel);
  note("");
  renderFunnel("note with an evidence clause", view.variants.withEvidence);
  note("");
  renderFunnel("note without one", view.variants.withoutEvidence);
  if (view.variants.unrecorded.invitesSent > 0) {
    note("");
    renderFunnel("sent before the clause was recorded", view.variants.unrecorded);
  }
  note("");
  note(
    c.dim(
      "Definitions are in docs/linkedin.md. Accepted by conversation misses most accepts on invites sent before the invitation status was read.",
    ),
  );
}

function parseSince(value: string | undefined): number | null {
  if (value === undefined) return null;
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(at)) throw new Error("--since must be a date, e.g. 2026-09-01");
  return at;
}

function statusOf(value: string | undefined): InviteStatusFilter | null {
  if (value === undefined) return null;
  if (!(STATUSES as readonly string[]).includes(value)) {
    throw new Error(`--status must be one of: ${STATUSES.join(", ")}`);
  }
  return value as InviteStatusFilter;
}

/** The detected state as a person reads it. */
function stateLabel(r: LinkedInInviteRow): string {
  if (r.state === "accepted") return `accepted (${r.acceptedVia})`;
  if (r.state === "withdrawn") return `withdrawn (${r.withdrawnBy})`;
  return r.state;
}

/** `linkedin invites`: one row per invite sent, to compare GTM's view with LinkedIn's. */
export async function commandLinkedInInvites(opts: LinkedInInvitesOptions = {}): Promise<void> {
  if (opts.json) setJsonMode(true);
  const sinceMs = parseSince(opts.since);
  const status = statusOf(opts.status);
  const { rows: all } = readLinkedInMeasure();
  const rows = all.filter(
    (r) =>
      (sinceMs === null || Date.parse(r.sentAt) >= sinceMs) &&
      (status === null || r.state === status),
  );
  if (opts.json) {
    await emitJson({ command: "linkedin invites", count: rows.length, invites: rows });
    return;
  }
  header("linkedin invites");
  if (rows.length === 0) {
    note("No invites match.");
    return;
  }
  for (const r of rows) {
    note(
      [
        r.sentAt.slice(0, 10),
        (r.prospect ?? "(no name)").padEnd(24),
        stateLabel(r).padEnd(24),
        (r.daysPending === null ? "-" : `${r.daysPending}d`).padEnd(5),
        `${r.stepKind} #${r.stepIndex}`.padEnd(16),
        r.conversationId ?? "-",
        r.profile ?? "-",
      ].join("  "),
    );
  }
  note(c.dim(`\n${rows.length} invite${rows.length === 1 ? "" : "s"}`));
}
