/**
 * Personal / free-tier email providers, curated small — used to keep the
 * calendar-matching `domain` fuzzy signal (packages/plays/src/_calendar.ts,
 * issue #577) from treating every personal-Gmail prospect as a hit on every
 * OTHER personal-Gmail prospect just because they share a mailbox provider.
 *
 * Deliberately NOT the same list as `packages/find/src/_findemail-prescreen.ts`'s
 * `DUD_DOMAINS`: that list also excludes app-preview subdomains, social
 * platforms and link aggregators (irrelevant here — this only guards a
 * DOMAIN-equality signal), and `plays` cannot depend on `find` without
 * creating a package cycle (`find` already depends on `plays`). Kept in
 * `core`, which both packages can import, rather than duplicating in each.
 */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "yandex.com",
  "mail.com",
]);

export function isFreemailDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return FREEMAIL_DOMAINS.has(domain.trim().toLowerCase());
}
