import {
  quoteSendingDomain,
  buySendingDomain,
  listPaymentHolds,
  resolvePaymentHold,
} from "@oneshot-gtm/core";
import {
  capGroupKey,
  identityCapacities,
  listSendingDomains,
  loadConfig,
  pauseSendingDomain,
  registerOneShotIdentity,
  removeIdentity,
  parseSendVia,
  resolveIdentities,
  resumeSendingDomain,
  sendTestEmail,
  setIdentitySendVia,
  WARMUP_DEFAULTS,
  type DomainPoolEntry,
} from "@oneshot-gtm/core";
import prompts from "prompts";
import { c, emitJson, header, note, ok, setJsonMode, warn } from "../output.ts";

/** Best-effort domain pool. Never let a transient/auth failure abort a list/add. */
async function safeListDomains(): Promise<{ domains: DomainPoolEntry[]; error: boolean }> {
  try {
    return { domains: await listSendingDomains(), error: false };
  } catch (err) {
    warn(`Could not reach the domain pool: ${(err as Error).message}`);
    return { domains: [], error: true };
  }
}

/** Show the rotation pool + the wallet's provisioned domain pool. */
export async function commandIdentitiesList(opts: { json?: boolean } = {}): Promise<void> {
  setJsonMode(opts.json ?? false);
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
  const { domains, error: domainsError } = await safeListDomains();
  if (domains.length === 0) {
    note(
      "None found. Set up a domain with domains quote, or retry if the pool could not be reached.",
    );
  } else {
    for (const d of domains) {
      note(
        `${d.mailbox_mode}: ${d.addresses?.map((a) => `${a.address} (${a.status})`).join(", ") ?? ""} · ${d.warmup_state}`,
      );
      note(
        `${d.domain}  ${c.dim(d.pool_status)}` +
          (d.warmup_score != null ? `  warmth ${d.warmup_score}` : "") +
          `  sent ${d.daily_sent_count}/${d.daily_send_limit}/day`,
      );
    }
  }

  if (opts.json) {
    await emitJson({
      command: "identities list",
      identities: identities.map((i) => {
        const cap = caps.get(i.id);
        const capToday = cap && Number.isFinite(cap.capToday) ? cap.capToday : null;
        return Object.assign(
          {
            id: i.id,
            provider: i.provider,
            address:
              i.mailbox && i.sendingDomain
                ? `${i.mailbox}@${i.sendingDomain}`
                : (i.address ?? i.sendingDomain ?? i.label ?? i.id),
            sentToday: cap?.identitySentToday ?? 0,
            capToday,
            legacy,
          },
          cap?.domainSentToday != null ? { domainSentToday: cap.domainSentToday } : {},
        );
      }),
      domains: domains.map((d) => ({
        domain: d.domain,
        defaultFrom: d.default_from,
        mailboxMode: d.mailbox_mode,
        warmupState: d.warmup_state,
        addresses: d.addresses,
        poolStatus: d.pool_status,
        warmupScore: d.warmup_score ?? null,
        dailySent: d.daily_sent_count,
        dailyLimit: d.daily_send_limit,
      })),
      ...(domainsError ? { domainsError: true } : {}),
    });
  }
}

/** Add an OneShot sending identity (a domain + mailbox) to the rotation pool. */
export async function commandIdentitiesAdd(): Promise<void> {
  header("Add OneShot sender");
  const { domains } = await safeListDomains();

  // Existing addresses are selectable; new ones need an explicit setup purchase.
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
        message: "Sending domain (existing, or a new domain to purchase)",
        validate: (v: string) => (v.trim().length > 0 ? true : "required"),
      },
      {
        type: "text",
        name: "mailbox",
        message: "Mailbox local-part (blank = domain main address, or agent for a new domain)",
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
  const existing = domains.find((d) => d.domain === domain);
  const mailbox =
    String(answers["mailbox"] ?? "")
      .trim()
      .toLowerCase() ||
    existing?.default_from?.split("@")[0] ||
    "agent";
  if (
    !existing?.addresses.some((a) => a.address === `${mailbox}@${domain}` && a.status === "active")
  ) {
    const choice = existing
      ? { mode: existing.mailbox_mode }
      : await prompts({
          type: "select",
          name: "mode",
          message: "Domain mode",
          choices: [
            { title: "Relay", value: "relay" },
            { title: "Hosted mailbox", value: "mailbox" },
          ],
          initial: 0,
        });
    if (!choice.mode) return;
    const quote = await quoteSendingDomain(domain, {
      mailbox_mode: choice.mode,
      addresses: [mailbox],
    });
    note(JSON.stringify(quote, null, 2));
    if (!quote.purchasable || !quote.quote_id || quote.total_cost == null || !quote.billing) {
      warn(quote.reason ?? "Setup not purchasable");
      return;
    }
    const confirmation = await prompts({
      type: "confirm",
      name: "buy",
      message: `Buy this setup for ${quote.currency ?? "USD"} ${quote.total_cost}? No email will be sent.`,
      initial: false,
    });
    if (!confirmation.buy) return;
    if (quote.expires_at && Date.parse(quote.expires_at) <= Date.now())
      throw new Error("Quote expired. Run identities add again to review a fresh quote.");
    const result = await buySendingDomain(domain, quote.quote_id);
    note(JSON.stringify(result, null, 2));
    const fresh = await listSendingDomains();
    if (
      !fresh
        .find((d) => d.domain === domain)
        ?.addresses.some((a) => a.address === `${mailbox}@${domain}` && a.status === "active")
    ) {
      note(
        "Setup requested; address is not active yet. Check domains list, then run identities add again. No sender was added.",
      );
      return;
    }
  }

  const capRaw = ((answers["cap"] as string) ?? "").trim();
  const capNum = Number.parseInt(capRaw, 10);
  const { identityId, created } = registerOneShotIdentity({
    sendingDomain: domain,
    mailbox,
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

/** Show just the wallet's provisioned domain pool with status + warmth + usage. */
export async function commandDomainsList(opts: { json?: boolean } = {}): Promise<void> {
  setJsonMode(opts.json ?? false);
  header("Provisioned domains");
  const { domains, error: domainsError } = await safeListDomains();
  if (domains.length === 0) {
    note("None found (or the pool couldn't be reached).");
  } else {
    for (const d of domains) {
      note(
        `${d.mailbox_mode}: ${d.addresses?.map((a) => `${a.address} (${a.status})`).join(", ") ?? ""} · ${d.warmup_state}`,
      );
      const tone =
        d.warmup_state === "warming" ? c.cyan : d.pool_status === "active" ? c.green : c.red;
      note(
        `${d.domain}  ${tone(d.pool_status)}` +
          (d.warmup_score != null ? `  warmth ${d.warmup_score}` : "") +
          `  sent ${d.daily_sent_count}/${d.daily_send_limit}/day`,
      );
    }
    if (domains.some((d) => d.pool_status === "paused" || d.pool_status === "removed")) {
      note("Resume a paused domain: oneshot-gtm domains resume <domain>");
    }
  }

  if (opts.json) {
    await emitJson({
      command: "domains list",
      domainsError,
      domains: domains.map((d) => ({
        domain: d.domain,
        defaultFrom: d.default_from,
        mailboxMode: d.mailbox_mode,
        warmupState: d.warmup_state,
        addresses: d.addresses,
        poolStatus: d.pool_status,
        warmupScore: d.warmup_score ?? null,
        dailySent: d.daily_sent_count,
        dailyLimit: d.daily_send_limit,
      })),
    });
  }
}

/** Resume a paused sending domain in the wallet's pool. */
export async function commandDomainsResume(domain: string): Promise<void> {
  const result = await resumeSendingDomain(domain);
  ok(`${c.cyan(result.domain)} → ${result.pool_status}`);
  if (result.pool_status !== "active") {
    warn(
      "Still not active — the pause may be account- or platform-level (not per-domain). " +
        "Check `oneshot-gtm doctor` and OneShot's status.",
    );
  }
}

/** Pause a sending domain in the wallet's pool (stop sending from it). */
export async function commandDomainsPause(domain: string): Promise<void> {
  const result = await pauseSendingDomain(domain);
  ok(`${c.cyan(result.domain)} → ${result.pool_status}`);
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

/**
 * `identities send-via <id> <provider|smtp>`: how a Smartlead mailbox sends.
 * `smtp` is refused unless the mailbox's SMTP + IMAP credentials resolve.
 */
export async function commandIdentitiesSendVia(identityId: string, raw: string): Promise<void> {
  const sendVia = parseSendVia(raw);
  const { changed, smtpHost } = await setIdentitySendVia(identityId, sendVia);
  const how = sendVia === "smtp" ? `direct SMTP (${smtpHost})` : "the Smartlead API";
  if (!changed) {
    note(`${c.cyan(identityId)} already sends via ${how}.`);
    return;
  }
  ok(`${c.cyan(identityId)} now sends via ${how}.`);
  if (sendVia === "smtp") {
    note(
      "Each email goes out under one fixed Message-ID and is confirmed in Sent by `sends check`.",
    );
  }
}

/** `identities test-send <id> --to <addr> [--step <label>] [--dry-run]`. */
export async function commandIdentitiesTestSend(
  identityId: string,
  opts: { to: string; step?: string; dryRun: boolean },
): Promise<void> {
  const { plan, result, receiptId } = await sendTestEmail({
    identityId,
    to: opts.to,
    ...(opts.step ? { step: opts.step } : {}),
    dryRun: opts.dryRun,
  });
  header(`SMTP test send${opts.dryRun ? " · dry run (nothing sent)" : ""}`);
  note(`identity    ${plan.identityId}`);
  note(`smtp host   ${plan.smtpHost ?? "?"}`);
  note(`from        ${plan.from}`);
  note(`to          ${plan.to}`);
  note(`subject     ${plan.subject}`);
  note(`message-id  ${plan.messageId}`);
  note(`key         ${plan.key}`);
  if (plan.existing) {
    warn(
      `an earlier attempt under this key is ${plan.existing}${plan.existing === "failed" ? " (a send retries under the same Message-ID)" : " (a send replays it, nothing new goes out)"}; pass --step to send a new one`,
    );
  }
  if (opts.dryRun) return;
  ok(`submitted · receipt ${receiptId ?? "?"} · ${result?.request_id ?? plan.messageId}`);
  note("`oneshot-gtm sends check` confirms it in Sent after ~3 minutes.");
}

export async function commandDomainsQuote(
  domain: string,
  opts: { mode?: string; addresses?: string; json?: boolean },
): Promise<void> {
  if (opts.json) setJsonMode(true);
  if (opts.mode && opts.mode !== "relay" && opts.mode !== "mailbox")
    throw new Error("Mode must be relay or mailbox");
  const result = await quoteSendingDomain(domain, {
    mailbox_mode: opts.mode as "relay" | "mailbox" | undefined,
    addresses: opts.addresses?.split(","),
  });
  if (opts.json) await emitJson({ command: "domains quote", ...result });
  else {
    note(JSON.stringify(result, null, 2));
    note("Accept this exact quote with domains buy <domain> --quote-id <id>. No email is sent.");
  }
}
export async function commandDomainsBuy(
  domain: string,
  opts: { quoteId: string; json?: boolean },
): Promise<void> {
  if (opts.json) setJsonMode(true);
  const result = await buySendingDomain(domain, opts.quoteId);
  if (opts.json) await emitJson({ command: "domains buy", ...result });
  else note(JSON.stringify(result, null, 2));
}
export async function commandPaymentsList(opts: { json?: boolean }): Promise<void> {
  if (opts.json) setJsonMode(true);
  const holds = listPaymentHolds();
  if (opts.json) await emitJson({ command: "payments list", holds });
  else note(JSON.stringify(holds, null, 2));
}
export async function commandPaymentsResolve(key: string, opts: { note: string }): Promise<void> {
  resolvePaymentHold(key, opts.note);
  ok(
    "Payment hold resolved. The operation may be attempted again; nothing was sent or purchased by this command.",
  );
}
