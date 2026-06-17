import {
  capGroupKey,
  fromLocalpart,
  identityCapacities,
  listSendingDomains,
  loadConfig,
  registerOneShotIdentity,
  removeIdentity,
  resolveIdentities,
  WARMUP_DEFAULTS,
  type DomainPoolEntry,
} from "@oneshot-gtm/core";
import prompts from "prompts";
import { c, header, note, ok, warn } from "../output.ts";

/** Best-effort domain pool — never let a transient/auth failure abort a list/add. */
async function safeListDomains(): Promise<DomainPoolEntry[]> {
  try {
    return await listSendingDomains();
  } catch (err) {
    warn(`Could not reach the domain pool: ${(err as Error).message}`);
    return [];
  }
}

/** Show the rotation pool + the wallet's provisioned domain pool. */
export async function commandIdentitiesList(): Promise<void> {
  header("Sender identities");
  const cfg = loadConfig();
  const identities = resolveIdentities(cfg);
  const legacy = cfg.emailIdentities == null;
  // Per cap-group capacity: caps + counts reflect the shared per-domain budget.
  const caps = identityCapacities();
  const groupSize = new Map<string, number>();
  for (const i of identities)
    groupSize.set(capGroupKey(i), (groupSize.get(capGroupKey(i)) ?? 0) + 1);

  for (const i of identities) {
    const cap = caps.get(i.id);
    const capStr = cap && Number.isFinite(cap.capToday) ? String(cap.capToday) : "∞";
    const shared = (groupSize.get(capGroupKey(i)) ?? 1) > 1;
    const usage = shared
      ? `today ${cap?.identitySentToday ?? 0} · domain ${cap?.domainSentToday ?? 0}/${capStr} shared`
      : `today ${cap?.identitySentToday ?? 0}/${capStr}`;
    const addr =
      i.mailbox && i.sendingDomain
        ? `${i.mailbox}@${i.sendingDomain}`
        : (i.address ?? i.sendingDomain ?? i.label ?? i.id);
    note(
      `${c.cyan(i.provider)}  ${addr}  ` +
        `[${c.dim(i.id)}]  ${usage}` +
        (legacy ? c.dim(" · legacy (auto-derived)") : ""),
    );
  }

  header("Provisioned domains");
  const domains = await safeListDomains();
  if (domains.length === 0) {
    note("None found (OneShot auto-provisions warm domains, or the pool couldn't be reached).");
    return;
  }
  for (const d of domains) {
    note(
      `${d.domain}  ${c.dim(d.pool_status)}` +
        (d.warmup_score != null ? `  warmth ${d.warmup_score}` : "") +
        `  sent ${d.daily_sent_count}/${d.daily_send_limit}/day`,
    );
  }
}

/** Add an OneShot sending identity (a domain + mailbox) to the rotation pool. */
export async function commandIdentitiesAdd(): Promise<void> {
  header("Add OneShot sender");
  const cfg = loadConfig();
  const domains = await safeListDomains();

  // Show the warmed pool as a reference, but accept ANY domain by free text: a
  // brand-new domain auto-provisions on first send, so restricting to the
  // current pool would block exactly the "add a new domain" flow.
  if (domains.length > 0) {
    note(
      "Provisioned domains: " +
        domains
          .map((d) => `${d.domain}${d.pool_status !== "active" ? ` (${d.pool_status})` : ""}`)
          .join(", "),
    );
  }

  const answers = await prompts(
    [
      {
        type: "text",
        name: "domain",
        message: "Sending domain (a provisioned one, or a new domain you control)",
        validate: (v: string) => (v.trim().length > 0 ? true : "required"),
      },
      {
        type: "text",
        name: "mailbox",
        message: `Mailbox local-part (blank = ${fromLocalpart(cfg.founderName)})`,
      },
      {
        type: "text",
        name: "cap",
        message: "Max sends/day (blank = cold-start warm-up ramp)",
      },
    ],
    { onCancel: () => process.exit(0) },
  );

  const domain = ((answers["domain"] as string) ?? "").trim().toLowerCase();
  if (!domain) {
    warn("No domain provided.");
    return;
  }
  // A domain not yet in the pool isn't an error — it auto-provisions on first
  // send. But pinned sends bypass the server's warm-up gating, so flag the
  // cold-start so the founder leans on the client cap (the default ramp).
  if (domains.length > 0 && !domains.some((d) => d.domain.toLowerCase() === domain)) {
    warn(
      `'${domain}' isn't provisioned yet — it'll auto-provision on first send and go out cold ` +
        `(server warm-up is bypassed for pinned sends). The client warm-up ramp is your throttle.`,
    );
  }

  const capRaw = ((answers["cap"] as string) ?? "").trim();
  const capNum = Number.parseInt(capRaw, 10);
  const { identityId, created } = registerOneShotIdentity({
    sendingDomain: domain,
    mailbox: (answers["mailbox"] as string) ?? "",
    ...(capRaw && Number.isFinite(capNum) && capNum >= 0 ? { maxPerDay: capNum } : {}),
  });

  if (!created) {
    ok(`Identity ${c.cyan(identityId)} already in the pool (no change).`);
    return;
  }
  const capMsg = capRaw
    ? `cap ${capNum}/day`
    : `warm-up ${WARMUP_DEFAULTS.warmup!.startPerDay}/day +${WARMUP_DEFAULTS.warmup!.incrementPerWeek}/wk, max ${WARMUP_DEFAULTS.maxPerDay}`;
  ok(`Identity ${c.cyan(identityId)} added to the rotation pool (${capMsg}).`);
  note("New prospects rotate across the pool; existing threads keep their original sender.");
}

/** Drop an identity from the pool by id. */
export async function commandIdentitiesRemove(identityId: string): Promise<void> {
  const { removed } = removeIdentity(identityId);
  if (!removed) {
    warn(`No identity '${identityId}' in the pool.`);
    return;
  }
  ok(`Removed ${c.cyan(identityId)} from the rotation pool.`);
  note("Prospects pinned to it will refuse to send until it's restored.");
}
