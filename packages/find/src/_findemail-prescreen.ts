/**
 * Pre-flight guard for `findEmail` SDK calls.
 *
 * The OneShot `findEmail` SDK receives only `company_domain` + `full_name` and
 * guesses email patterns from those. Two structural causes of dud lookups we
 * can catch BEFORE spending the ~$0.05 per call:
 *
 *   1. `company_domain` points at a host where no company hosts email —
 *      free-tier app subdomains (vercel.app, github.io, …), social platforms,
 *      personal email providers, code hosts, link aggregators.
 *   2. `full_name` is a single-token handle (`samaralihussain`) not a real
 *      person name (`Sam Jones`). Pattern-based email guessing can't
 *      disambiguate a username.
 *
 * Callers do `shouldSkipFindEmail(...)` ahead of the SDK call; when it
 * returns `{ok:false}`, increment `result.droppedEnrichment` and emit a
 * `finder.skipped_findemail` event for telemetry, then move to the next
 * candidate. No new wire-protocol surface.
 */

/**
 * Hosts where `findEmail` virtually never finds a deliverable company
 * address. Match is exact on the bare host or any subdomain of one of
 * these entries — `foo.vercel.app` and `bar.foo.vercel.app` both qualify.
 *
 * Curated, static. Adaptive/learned variants are out of scope.
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
  // Personal / free email providers — the founder isn't reachable via the
  // generic free-tier handle even if findEmail returns something.
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
  // Investor / startup-data aggregators — every result here is a profile
  // page about a company, not the company's own domain.
  "crunchbase.com",
  "producthunt.com",
  "wellfound.com",
  "pitchbook.com",
  "cbinsights.com",
  "tracxn.com",
  // Code hosts (when this is the ONLY domain signal — caller already
  // failed to find a company website).
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
 * True when the given domain is in the dud blocklist, either as an exact
 * match or as a subdomain (so `foo.vercel.app` is dud). `null`/empty
 * counts as dud — caller has no usable signal.
 *
 * Defensive normalization before matching:
 *   - lowercase + trim whitespace
 *   - strip `http://` / `https://` scheme
 *   - strip everything from the first `/` onward (paths/queries)
 *   - strip leading `www.` and trailing `.`
 *
 * Callers should pass bare hostnames (via `urlDomain` from `_dedupe.ts`),
 * but the normalization keeps an accidental full URL or trailing-dot DNS
 * form from silently slipping past the suffix match.
 *
 * Does no DNS lookup — purely suffix-based.
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
 * True when the input looks like a single-token username/handle rather
 * than a real person name. Heuristics, in order:
 *
 *   - Empty / null → handle (no signal).
 *   - Contains whitespace → looks like a name. `"Sam Jones"`.
 *   - Contains a period → looks like a name. `"Sam J. Jones"`.
 *   - Single token of `[a-z0-9_-]` (case-insensitive) → handle.
 *
 * False-positive accepted: a real single-name like `Madonna` reads as a
 * handle. That's a fine tradeoff vs the volume of HN-style usernames we
 * filter out (90%+ of Show HN authors).
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
 * Pre-flight guard. Returns `{ok:true}` to proceed with the SDK call, or
 * `{ok:false, reason}` to skip. The reason is human-readable and stable
 * across releases — safe to log via `finder.skipped_findemail` for later
 * blocklist tuning.
 *
 * Check order matters: a missing/dud domain dominates a handle check (no
 * point flagging "handle-not-name" when the domain alone would have
 * disqualified the row).
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
