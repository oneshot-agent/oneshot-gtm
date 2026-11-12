/**
 * The workspace's do-not-contact list (`doNotContact` in config.json): whole
 * companies nobody in this workspace may reach, by domain or by name. The
 * queue insert, every email send, the LinkedIn invite guard and the cadence
 * step all ask `doNotContactMatch`.
 */
import { bareDomain, currentDoNotContact, type DoNotContactList } from "./config.ts";

type Field = string | null | undefined | readonly (string | null | undefined)[];

/** What a gate knows about the person it is about to contact; each field may hold several values. */
export interface ContactIdentity {
  email?: Field;
  company?: Field;
  /** A stated company domain. */
  domain?: Field;
  website?: Field;
}

function values(field: Field): string[] {
  const list = Array.isArray(field) ? field : [field];
  return list.filter((value): value is string => typeof value === "string" && !!value.trim());
}

export interface DoNotContactMatch {
  kind: "domain" | "company";
  /** The list entry that matched, as written in config. */
  entry: string;
}

// Words that name a company's legal or professional form, not the company.
const FORM_WORDS = new Set([
  "the",
  "inc",
  "incorporated",
  "llc",
  "pllc",
  "llp",
  "lp",
  "ltd",
  "limited",
  "co",
  "corp",
  "corporation",
  "company",
  "pc",
  "pa",
  "plc",
  "gmbh",
  "dds",
  "dmd",
  "md",
]);

function companyTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !FORM_WORDS.has(token));
}

/** `needle`'s tokens appear in `hay` in order, side by side. */
function containsRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((token, j) => hay[i + j] === token)) return true;
  }
  return false;
}

function domainBlocked(host: string, blocked: string): boolean {
  return host === blocked || host.endsWith(`.${blocked}`);
}

/**
 * The entry that blocks this person, or null. A domain matches the email's
 * domain, the stated domain or the website's host, itself or any subdomain of
 * it. A company name matches when its words, legal form dropped, appear in
 * order in the person's company: "Example Dental" blocks "Example Dental,
 * PLLC" and "Example Dental of Springfield", not "Example Family Dental".
 */
export function doNotContactMatch(
  identity: ContactIdentity,
  list: DoNotContactList = currentDoNotContact(),
): DoNotContactMatch | null {
  if (list.domains.length > 0) {
    const hosts = [identity.email, identity.domain, identity.website]
      .flatMap(values)
      .map(bareDomain)
      .filter((host): host is string => !!host);
    for (const blocked of list.domains) {
      if (hosts.some((host) => domainBlocked(host, blocked))) {
        return { kind: "domain", entry: blocked };
      }
    }
  }
  if (list.companies.length > 0) {
    const names = values(identity.company).map(companyTokens);
    for (const entry of list.companies) {
      const blocked = companyTokens(entry);
      if (names.some((tokens) => containsRun(tokens, blocked))) return { kind: "company", entry };
    }
  }
  return null;
}

function strings(payload: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys
    .map((key) => payload[key])
    .filter((value): value is string => typeof value === "string" && !!value.trim());
}

/** Every identity a queue row's payload carries, under the keys finders write. */
export function queuePayloadIdentity(payload: unknown): ContactIdentity {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  return {
    email: strings(p, ["email", "founderEmail", "guestEmail"]),
    company: strings(p, ["company", "companyName", "organization", "guestCompany", "newCompany"]),
    domain: strings(p, ["companyDomain", "domain", "guestCompanyDomain", "newCompanyDomain"]),
    website: strings(p, ["website", "websiteUrl"]),
  };
}

/** One line naming the match, for notes, refusals and stop notes. */
export function describeDoNotContact(match: DoNotContactMatch): string {
  return match.kind === "domain"
    ? `the domain ${match.entry} is on the do-not-contact list`
    : `the company "${match.entry}" is on the do-not-contact list`;
}
