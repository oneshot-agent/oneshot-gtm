import { logEvent } from "./events.ts";
import type { DomainSetupChoice, DomainSetupQuote, DomainSetupPurchase } from "@oneshot-agent/sdk";
import { getAgent, buildAuditOpts } from "./oneshot.ts";
import { getLedger } from "./ledger.ts";
import { demoMode } from "./demo.ts";
export type { DomainSetupChoice, DomainSetupQuote, DomainSetupPurchase };

export function validateDomainSetup(
  domain: string,
  options: DomainSetupChoice = {},
): { domain: string; options: DomainSetupChoice } {
  domain = domain.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain))
    throw new Error("Enter a domain name without a URL or email address");
  if (options.mailbox_mode !== undefined && !["relay", "mailbox"].includes(options.mailbox_mode))
    throw new Error("Mode must be relay or mailbox");
  const addresses = (options.addresses ?? ["agent"]).map((a) => a.trim().toLowerCase());
  if (
    addresses.length < 1 ||
    addresses.length > 10 ||
    new Set(addresses).size !== addresses.length ||
    addresses.some((a) => !/^[a-z0-9][a-z0-9._+-]*$/.test(a))
  )
    throw new Error("Supply 1–10 unique address local parts");
  return {
    domain,
    options: { ...(options.mailbox_mode ? { mailbox_mode: options.mailbox_mode } : {}), addresses },
  };
}

export async function quoteSendingDomain(
  domain: string,
  options: DomainSetupChoice = {},
): Promise<DomainSetupQuote> {
  const input = validateDomainSetup(domain, options);
  if (demoMode()) throw new Error("Domain purchases are unavailable in demo mode");
  return (await getAgent()).quoteDomain(input.domain, {
    ...input.options,
    ...buildAuditOpts({ playName: "domain-setup" }, "domain.quote"),
  });
}

export async function buySendingDomain(
  domain: string,
  quoteId: string,
): Promise<DomainSetupPurchase> {
  domain = validateDomainSetup(domain).domain;
  if (!quoteId.trim()) throw new Error("An explicitly accepted quote ID is required");
  if (demoMode()) throw new Error("Domain purchases are unavailable in demo mode");
  const audit = buildAuditOpts({ playName: "domain-setup" }, "domain.setup");
  const result = await (await getAgent()).buyDomain(domain, quoteId.trim(), audit);
  try {
    getLedger().recordReceipt({
      playName: "domain-setup",
      callType: "domain.setup",
      signedReceipt: result,
      oneshotRequestId: result.request_id,
      ...audit,
    });
  } catch {
    // Provider success is authoritative even if this local ledger is unavailable.
    logEvent(
      "domain.setup_receipt_failed",
      { domain, request_id: result.request_id, receipt_id: result.receipt_id },
      "error",
    );
  }
  return result;
}
