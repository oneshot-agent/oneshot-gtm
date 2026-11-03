import {
  currentWorkspaceName,
  getLedger,
  getSharedDb,
  linkedInOutreachAccount,
  normalizeLinkedInProfile,
  parseLinkedInRecovery,
  settleLinkedInInviteClaim,
  type LinkedInPendingSend,
} from "@oneshot-gtm/core";
import { LINKEDIN_SEND_PENDING } from "@oneshot-gtm/shared-types";
import {
  cadenceInviteRowFor,
  cadenceInviteStepIndex,
  cadenceLinkedInMessageKey,
  effectiveSequence,
  type LinkedInCaller,
  type StepPayload,
} from "./_cadence.ts";
import { inviteRefusedFlag, linkedInInviteKey } from "./_linkedin-first-touch.ts";
import { linkedInSenderFor } from "./_linkedin-invites.ts";
import {
  holdQueueRow,
  resolveLinkedInPendingSend,
  type LinkedInPendingResolution,
} from "./_linkedin-pending.ts";

/**
 * `oneshot-gtm linkedin reconcile`: a one-time pass over LinkedIn sends that
 * were recorded as failed while OneShot was still working on them (the
 * cross-workspace worker stopped waiting), and over invite claims that never
 * settled. It reads OneShot's records (recover, wait, invitations) and, with
 * `write`, records what they prove, exactly as the LinkedIn sweep would. It
 * never sends.
 */

/** The send error a cadence kept when the worker gave up on a running job. */
const WORKER_STOPPED = "LinkedIn workspace worker stopped before returning a result";

export interface LinkedInReconcileItem {
  prospectId: number | null;
  playName: string | null;
  kind: "message" | "reply" | "invite" | "claim";
  /** The idempotency key asked about, or the profile slug for a claim. */
  key: string;
  /** What OneShot says: completed / failed / in_flight / unknown, or not_sent for a claim. */
  state: string;
  /** What was done (or, dry run, would be). */
  action: string;
}

export interface LinkedInReconcileReport {
  write: boolean;
  items: LinkedInReconcileItem[];
}

function stuckOnLinkedIn(error: string | null): boolean {
  return !!error && (error.startsWith(WORKER_STOPPED) || error === LINKEDIN_SEND_PENDING);
}

const wouldDo: Record<LinkedInPendingResolution, string> = {
  sent: "record the send and move the cadence on",
  failed: "record the failure",
  refused: "free the profile and skip the LinkedIn steps",
  pending: "leave pending",
};

export async function reconcileLinkedInSends(input: {
  linkedIn: LinkedInCaller;
  write: boolean;
}): Promise<LinkedInReconcileReport> {
  const ledger = getLedger();
  const workspace = currentWorkspaceName();
  const items: LinkedInReconcileItem[] = [];
  /** Profiles whose claim (1) handled, so (2) leaves them alone. */
  const handledSlugs = new Set<string>();

  // (1) Cadences whose LinkedIn send was recorded as failed when the worker
  // stopped, or that are pending: ask OneShot by the key the dispatch used.
  for (const cadence of ledger.listActiveCadences()) {
    if (!stuckOnLinkedIn(cadence.last_send_error)) continue;
    const draft = ledger.getCadenceDraft({
      prospectId: cadence.prospect_id,
      playName: cadence.play_name,
    });
    const payload = draft?.payload as StepPayload | undefined;
    if (payload?.kind !== "linkedin_message" && payload?.kind !== "linkedin_invite") continue;
    const seq = effectiveSequence(cadence.play_name, cadence.prospect_id);
    const step = seq?.steps[cadence.current_step];
    if (!step) continue;
    // The step the dispatch sent: `current_step + 1` (the step after the last one sent).
    const nextIndex = cadence.current_step + 1;
    const pending = buildPending({
      cadence,
      payload,
      workspace,
      stepIndex:
        payload.kind === "linkedin_invite"
          ? cadenceInviteStepIndex(cadence.prospect_id, cadence.play_name, step, nextIndex)
          : nextIndex,
      label: step.label ?? null,
    });
    if (!pending) continue;
    if (pending.kind === "invite") {
      const slug = normalizeLinkedInProfile(cadence.prospect_linkedin_url)?.key;
      if (slug) handledSlugs.add(slug);
    }
    items.push(await reconcileOne(pending, input));
  }

  // (2) Invite claims that never settled. A claim is freed only on proof
  // that its invite went nowhere: a `not_sent` invitation to the profile
  // whose status changed after the claim was taken (its own invite, by the
  // row's key, when one is known), and no live invitation to the profile on
  // the account. Whatever can't be established keeps the claim.
  const account = linkedInOutreachAccount();
  const claims = getSharedDb()
    .listUnsettledLinkedInTouches(`invite:${workspace}`)
    .filter((c) => !handledSlugs.has(c.slug));
  if (account && claims.length > 0) {
    const call = (operation: Parameters<LinkedInCaller>[1]) =>
      input.linkedIn(account.workspace, operation);
    const since = claims.map((c) => c.touched_at).toSorted()[0]!;
    const invitations = await readInvitations(call, account.accountId, since);
    const pendingSlugs = new Set(
      ledger.linkedInPending
        .list()
        .filter((p) => p.kind === "invite")
        .map((p) => inviteSlugOf(p.detail["row"]))
        .filter((slug): slug is string => !!slug),
    );
    const queueRows = ledger
      .listQueue({ status: "approved", limit: 10_000 })
      .filter((r) => r.channel === "linkedin");
    for (const claim of claims) {
      const item = { prospectId: null, playName: null, kind: "claim" as const, key: claim.slug };
      const keep = (state: string, why: string) =>
        items.push({ ...item, state, action: `kept: ${why}` });
      if (pendingSlugs.has(claim.slug)) {
        keep("pending", "a pending send holds it; the LinkedIn sweep resolves it");
        continue;
      }
      if (!invitations.liveComplete) {
        keep("unknown", "the account's live invitations could not all be read");
        continue;
      }
      if (invitations.live.has(claim.slug)) {
        keep("live", "the account has a pending or accepted invitation to this profile");
        continue;
      }
      const claimedAt = Date.parse(claim.touched_at);
      const newer = (at: string | null) => !!at && Date.parse(at) > claimedAt;
      // Its own invite, when a queue row for the profile names the key.
      const row = queueRows.find((r) => inviteSlugOf(rowOf(r)) === claim.slug);
      let proof: { state: string; code: string; own: boolean } | null = null;
      if (row) {
        const own = await ownInviteRefused(call, account.accountId, row.id, workspace);
        if (own.state === "completed") {
          keep("completed", "OneShot says its invite went out");
          continue;
        }
        if (own.state === "not_sent" && newer(own.updatedAt)) {
          proof = { state: "not_sent (its own invite)", code: own.code, own: true };
        }
      }
      if (!proof && (invitations.notSent.get(claim.slug) ?? []).some(newer)) {
        proof = { state: "not_sent", code: "not_sent", own: false };
      }
      if (!proof) {
        keep("unproven", "no not_sent invitation to this profile newer than the claim");
        continue;
      }
      if (input.write) {
        // Freed only once the release itself landed; otherwise the claim stands.
        const profile = normalizeLinkedInProfile(`https://www.linkedin.com/in/${claim.slug}`);
        if (!profile || !settleLinkedInInviteClaim({ profile, workspace, outcome: "release" })) {
          keep("unproven", "the claim could not be released; try again");
          continue;
        }
        if (row && proof.own) {
          holdQueueRow(row.id, [inviteRefusedFlag(proof.code)]);
          // Its invite job failed: sent again, it goes under a new key.
          ledger.linkedInSendAttempts.markFailed(
            ledger.linkedInSendAttempts.key(
              linkedInInviteKey({ row: { id: row.id, playName: "" }, workspace }),
            ),
            proof.code,
          );
        }
      }
      items.push({
        ...item,
        state: proof.state,
        action: input.write ? "freed the profile" : "would free the profile",
      });
    }
  }
  return { write: input.write, items };
}

/** Most invitations one status call returns (the API's ceiling); a full page may hide more. */
const INVITATIONS_PAGE = 100;

interface InvitationsRead {
  /** `not_sent` invitations changed since the oldest claim, by profile: their `updated_at`. */
  notSent: Map<string, Array<string | null>>;
  /** Profiles with a pending or accepted invitation. */
  live: Set<string>;
  /** Both live lists were read whole (no error, no full page). */
  liveComplete: boolean;
}

async function readInvitations(
  call: (operation: Parameters<LinkedInCaller>[1]) => Promise<unknown>,
  accountId: string,
  since: string,
): Promise<InvitationsRead> {
  const out: InvitationsRead = { notSent: new Map(), live: new Set(), liveComplete: true };
  const list = async (status: "not_sent" | "pending" | "accepted", changedSince?: string) => {
    const res = (await call({
      kind: "invitations",
      accountId,
      status,
      ...(changedSince ? { changedSince } : {}),
      limit: INVITATIONS_PAGE,
    })) as { invitations?: Array<{ profile?: unknown; updated_at?: unknown }> } | null;
    return Array.isArray(res?.invitations) ? res.invitations : null;
  };
  try {
    for (const inv of (await list("not_sent", since)) ?? []) {
      const key = profileKey(inv.profile);
      if (!key) continue;
      const at = typeof inv.updated_at === "string" ? inv.updated_at : null;
      out.notSent.set(key, [...(out.notSent.get(key) ?? []), at]);
    }
  } catch {
    // no not_sent list: nothing is proved, every claim is kept
  }
  // Live invitations of any age count, so these are read unfiltered: a full
  // page or an error means absence can't be established.
  for (const status of ["pending", "accepted"] as const) {
    try {
      const page = await list(status);
      if (!page || page.length >= INVITATIONS_PAGE) out.liveComplete = false;
      for (const inv of page ?? []) {
        const key = profileKey(inv.profile);
        if (key) out.live.add(key);
      }
    } catch {
      out.liveComplete = false;
    }
  }
  return out;
}

/**
 * The outcome of a queue row's own invite, by its idempotency key: recover,
 * then the invitation it names. `not_sent` carries the invitation's
 * `updated_at` and the job's failure code.
 */
async function ownInviteRefused(
  call: (operation: Parameters<LinkedInCaller>[1]) => Promise<unknown>,
  accountId: string,
  queueId: number,
  workspace: string,
): Promise<{
  state: "completed" | "not_sent" | "unknown";
  updatedAt: string | null;
  code: string;
}> {
  const unknown = { state: "unknown" as const, updatedAt: null, code: "not_sent" };
  try {
    const recovery = parseLinkedInRecovery(
      await call({
        kind: "recover",
        endpoint: "linkedin/invite",
        // The key its latest invite went under.
        idempotencyKey: getLedger().linkedInSendAttempts.key(
          linkedInInviteKey({ row: { id: queueId, playName: "" }, workspace }),
        ),
      }),
    );
    if (recovery.state === "completed") return { ...unknown, state: "completed" };
    if (recovery.state !== "failed" || !recovery.invitationId) return unknown;
    const invitation = (await call({
      kind: "invitation",
      accountId,
      invitationId: recovery.invitationId,
    })) as { status?: unknown; updated_at?: unknown } | null;
    if (invitation?.status !== "not_sent") return unknown;
    let code = "not_sent";
    if (recovery.requestId) {
      try {
        await call({ kind: "wait", requestId: recovery.requestId });
      } catch (err) {
        const c = (err as { code?: unknown }).code;
        if (typeof c === "string" && /^[a-z][a-z_]{1,39}$/.test(c)) code = c;
      }
    }
    return {
      state: "not_sent",
      updatedAt: typeof invitation.updated_at === "string" ? invitation.updated_at : null,
      code,
    };
  } catch {
    return unknown;
  }
}

/** The profile slug a queue row or a stored invite row points at. */
function inviteSlugOf(row: unknown): string | null {
  const payload = (row as { payload?: { linkedinUrl?: unknown } } | null)?.payload;
  const url = payload?.linkedinUrl;
  return typeof url === "string" ? (normalizeLinkedInProfile(url)?.key ?? null) : null;
}

function rowOf(row: { payload_json: string }): { payload: Record<string, unknown> } | null {
  try {
    const payload: unknown = JSON.parse(row.payload_json);
    return payload && typeof payload === "object"
      ? { payload: payload as Record<string, unknown> }
      : null;
  } catch {
    return null;
  }
}

/** An invitation's `profile`: a slug or a profile URL. */
function profileKey(profile: unknown): string | null {
  if (typeof profile !== "string" || !profile.trim()) return null;
  const p = profile.trim();
  if (!p.includes("/")) return p.toLowerCase();
  return normalizeLinkedInProfile(p)?.key ?? null;
}

function buildPending(input: {
  cadence: { prospect_id: number; play_name: string };
  payload: Extract<StepPayload, { kind: "linkedin_message" | "linkedin_invite" }>;
  workspace: string;
  stepIndex: number;
  label: string | null;
}): Omit<LinkedInPendingSend, "requestId" | "createdAt" | "lastCheckedAt" | "checks"> | null {
  const { cadence, payload, workspace, stepIndex } = input;
  const base = {
    prospectId: cadence.prospect_id,
    playName: cadence.play_name,
    stepIndex,
    queueId: null,
  };
  if (payload.kind === "linkedin_message") {
    // The account the dispatch sent from.
    const sender = linkedInSenderFor(cadence.prospect_id, cadence.play_name);
    if (!sender) return null;
    return {
      ...base,
      kind: "message",
      // The key the latest send went under.
      idempotencyKey: getLedger().linkedInSendAttempts.key(
        cadenceLinkedInMessageKey(workspace, cadence.prospect_id, cadence.play_name, stepIndex),
      ),
      accountWorkspace: sender.workspace,
      accountId: sender.accountId,
      detail: { text: payload.text, label: input.label },
    };
  }
  const account = linkedInOutreachAccount();
  const row = cadenceInviteRowFor(cadence.prospect_id, cadence.play_name);
  if (!account || !row) return null;
  const continuation = { prospectId: cadence.prospect_id, stepIndex };
  return {
    ...base,
    kind: "invite",
    idempotencyKey: getLedger().linkedInSendAttempts.key(
      linkedInInviteKey({ row, workspace, continuation }),
    ),
    accountWorkspace: account.workspace,
    accountId: account.accountId,
    detail: {
      row,
      note: payload.note,
      continuation,
      ...(payload.evidenceClause !== undefined ? { evidenceClause: payload.evidenceClause } : {}),
    },
  };
}

async function reconcileOne(
  candidate: Omit<LinkedInPendingSend, "requestId" | "createdAt" | "lastCheckedAt" | "checks">,
  input: { linkedIn: LinkedInCaller; write: boolean },
): Promise<LinkedInReconcileItem> {
  const ledger = getLedger();
  const call = (operation: Parameters<LinkedInCaller>[1]) =>
    input.linkedIn(candidate.accountWorkspace, operation);
  const item = {
    prospectId: candidate.prospectId,
    playName: candidate.playName,
    kind: candidate.kind,
    key: candidate.idempotencyKey,
  };
  let recovery: ReturnType<typeof parseLinkedInRecovery>;
  try {
    recovery = parseLinkedInRecovery(
      await call({
        kind: "recover",
        endpoint: candidate.kind === "invite" ? "linkedin/invite" : "linkedin/message",
        idempotencyKey: candidate.idempotencyKey,
      }),
    );
  } catch (err) {
    return {
      ...item,
      state: "unknown",
      action: `unreadable (${((err as Error).message ?? "").slice(0, 80)}): left as it is`,
    };
  }
  if ((recovery.state !== "completed" && recovery.state !== "failed") || !recovery.requestId) {
    return { ...item, state: recovery.state, action: "left as it is" };
  }
  if (!input.write) {
    let action = wouldDo[recovery.state === "completed" ? "sent" : "failed"];
    // A failed invite frees the profile only when its invitation reads not_sent.
    if (candidate.kind === "invite" && recovery.state === "failed" && recovery.invitationId) {
      const invitation = (await call({
        kind: "invitation",
        accountId: candidate.accountId,
        invitationId: recovery.invitationId,
      }).catch(() => null)) as { status?: unknown } | null;
      if (invitation?.status === "not_sent") action = wouldDo.refused;
    }
    return { ...item, state: recovery.state, action: `would ${action}` };
  }
  // Recorded as pending under the key, then resolved exactly as the sweep does.
  ledger.linkedInPending.record({ ...candidate, requestId: recovery.requestId });
  const pending = ledger.linkedInPending.get(candidate.idempotencyKey);
  if (!pending) return { ...item, state: recovery.state, action: "could not record" };
  const resolution = await resolveLinkedInPendingSend(pending, input.linkedIn);
  return {
    ...item,
    state: recovery.state,
    action: resolution === "pending" ? "left pending" : `${resolution}: ${wouldDo[resolution]}`,
  };
}
