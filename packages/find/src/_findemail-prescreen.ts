/**
 * Pre-flight guard for paid `findEmail` SDK calls: skip when `company_domain`
 * is a host where no company hosts email (free-tier subdomains, social
 * platforms, personal providers, …) or `full_name` is a single-token handle
 * pattern-guessing can't use. Callers treat `{ok:false}` as droppedEnrichment
 * and emit `finder.skipped_findemail`.
 */

/**
 * Hosts where `findEmail` virtually never finds a deliverable company address.
 * Matched on the bare host or any subdomain. Curated, static.
 */
const DUD_DOMAINS: ReadonlySet<string> = new Set([
  // Free-tier app / preview subdomains.
  "vercel.app",
  "netlify.app",
  "github.io",
  "pages.dev",
  "fly.dev",
  "replit.co",
  "replit.app",
  "codesandbox.io",
  "stackblitz.com",
  "glitch.me",
  "deno.dev",
  "workers.dev",
  "herokuapp.com",
  "onrender.com",
  "railway.app",
  "modal.run",
  "supabase.co",
  "firebaseapp.com",
  "appspot.com",
  "azurewebsites.net",
  "webflow.io",
  "wixsite.com",
  "googleusercontent.com",
  // Personal / free email providers.
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  // Social, community, content hosts.
  "twitter.com",
  "x.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "youtu.be",
  "reddit.com",
  "medium.com",
  "dev.to",
  "substack.com",
  "hashnode.com",
  "hashnode.dev",
  "notion.site",
  "notion.so",
  "tiktok.com",
  "pinterest.com",
  "threads.net",
  "discord.com",
  "discord.gg",
  "slack.com",
  "news.ycombinator.com",
  // Investor / startup-data aggregators (profile pages, not company domains).
  "crunchbase.com",
  "producthunt.com",
  "wellfound.com",
  "pitchbook.com",
  "cbinsights.com",
  "tracxn.com",
  // Code hosts (only ever the domain signal when no company website was found).
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "gist.github.com",
  // Link aggregators.
  "linktr.ee",
  "bio.link",
  "carrd.co",
]);

/**
 * True when the domain is in the dud blocklist, exact or as a subdomain.
 * `null`/empty counts as dud (no usable signal). Defensively normalizes
 * scheme/path/www/trailing-dot so an accidental full URL can't slip past the
 * suffix match. Purely suffix-based — no DNS lookup.
 */
export function isDudDomain(domain: string | null | undefined): boolean {
  if (!domain) return true;
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "")
    .replace(/\.+$/, "");
  if (d.length === 0) return true;
  if (DUD_DOMAINS.has(d)) return true;
  for (const dud of DUD_DOMAINS) {
    if (d.endsWith(`.${dud}`)) return true;
  }
  return false;
}

/**
 * True when the input looks like a single-token username/handle rather than a
 * real person name (whitespace or a period reads as a name). Accepted
 * false-positive: a real mononym like `Madonna` reads as a handle.
 */
export function looksLikeUserHandle(name: string | null | undefined): boolean {
  if (name == null) return true;
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  if (/\s/.test(trimmed)) return false;
  if (trimmed.includes(".")) return false;
  return /^[a-z0-9_-]+$/i.test(trimmed);
}

/**
 * Pre-flight guard. `{ok:false, reason}` skips the SDK call; reasons are
 * stable across releases (logged for blocklist tuning). Check order matters:
 * a missing/dud domain dominates the handle check.
 */
export function shouldSkipFindEmail(input: {
  fullName?: string | null;
  companyDomain: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.companyDomain || input.companyDomain.trim().length === 0) {
    return { ok: false, reason: "no-domain" };
  }
  if (isDudDomain(input.companyDomain)) {
    return { ok: false, reason: `dud-domain: ${input.companyDomain.toLowerCase()}` };
  }
  const name = input.fullName?.trim() ?? "";
  if (name.length === 0) {
    return { ok: false, reason: "no-fullname" };
  }
  if (looksLikeUserHandle(name)) {
    return { ok: false, reason: `handle-not-name: ${name}` };
  }
  return { ok: true };
}
