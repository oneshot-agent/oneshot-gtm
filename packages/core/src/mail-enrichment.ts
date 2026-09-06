import { extractBusinessAddress } from "./mail-address.ts";
import { getLedger } from "./ledger.ts";

/** Company-scoped SDK data only. Never interpret a person's location as a mailing address. */
export function extractSdkBusinessAddress(value: unknown, name = "") {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const company =
    record.company && typeof record.company === "object"
      ? (record.company as Record<string, unknown>)
      : null;
  if (company) {
    const nested = company.address ?? company.headquarters ?? company.location;
    return extractBusinessAddress(company, name) ?? extractBusinessAddress(nested, name);
  }
  // Profile results may expose a explicitly business-scoped address.
  const profile =
    record.profile && typeof record.profile === "object"
      ? (record.profile as Record<string, unknown>)
      : record;
  if (profile.company && typeof profile.company === "object")
    return extractSdkBusinessAddress({ company: profile.company }, name);
  return extractBusinessAddress(
    profile.business_address ??
      profile.businessAddress ??
      profile.company_address ??
      profile.companyAddress,
    name,
  );
}

/** Capture SDK business address evidence without overwriting a founder's saved correction. */
export function captureSdkBusinessAddress(
  value: unknown,
  context: { companyDomain?: string; email?: string; name?: string; source: string },
) {
  const address = extractSdkBusinessAddress(value, context.name);
  if (!address) return;
  const ledger = getLedger();
  if (typeof context.companyDomain === "string" && context.companyDomain) {
    const domain = context.companyDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split("/")[0];
    if (domain && !ledger.getMailAddress(`company:${domain}`))
      ledger.setMailAddress(`company:${domain}`, address, context.source);
  }
  const match =
    typeof context.email === "string" && context.email
      ? ledger.findProspectByEmail(context.email)
      : null;
  const prospect = match ? ledger.getProspectById(match.id) : null;
  if (prospect && !ledger.getMailAddress(`prospect:${prospect.id}`))
    ledger.setMailAddress(
      `prospect:${prospect.id}`,
      { ...address, name: prospect.name ?? address.name },
      context.source,
    );
}
