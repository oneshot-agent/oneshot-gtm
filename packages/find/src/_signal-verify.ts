import { getLedger, htmlToText, logEvent, webRead, webSearch } from "@oneshot-gtm/core";

/**
 * Checks a list-page company against its own public evidence before any
 * paid contact step. A list somebody else compiled ("companies using X")
 * says only that someone said so; the company's subprocessor list, careers
 * page or engineering blog says it in the company's own words.
 *
 * Two kinds of evidence, chosen per source by what the tool is:
 * - `subprocessors`: hosted vendors that touch customer data (an LLM API, a
 *   browser cloud). Only this one can say "absent": a real subprocessor list
 *   that does not name the vendor.
 * - `mentions`: self-hosted tools (Backstage) never appear on a
 *   subprocessor list, so the check looks for the company naming the tool on
 *   its own site or in a job post. Confirm-only: silence is not absence.
 *
 * Matching is string matching on the names the config gives; no model call.
 */

export type VerifyVia = "subprocessors" | "mentions";

export interface SignalVerifyConfig {
  /** The vendor or tool and its aliases ("Browserbase"; "OpenAI", "Open AI"). */
  names: string[];
  via: VerifyVia[];
}

export type SignalVerdict = "confirmed" | "absent" | "unknown";

export interface SignalVerifyResult {
  verdict: SignalVerdict;
  /** The page that confirmed it, or the subprocessor list that left it out. */
  url?: string;
  via?: VerifyVia;
  costUsd: number;
  /** A paid step failed: the verdict is "unknown" for now and is not cached. */
  errored?: boolean;
}

const PLAY_NAME = "design-partner-loi";
const FETCH_TIMEOUT_MS = 10_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAGE_CHARS = 600_000;

const SUBPROCESSOR_PATHS = [
  "/subprocessors",
  "/sub-processors",
  "/legal/subprocessors",
  "/legal/sub-processors",
  "/legal/subprocessor-list",
  "/privacy/subprocessors",
  "/security/subprocessors",
  "/trust",
];

/**
 * Processors nearly every subprocessor list names. A page that says
 * "subprocessors" but names fewer than `MIN_COMMON_PROCESSORS` of these is a
 * heading over content loaded by script (a trust-centre shell), not a list,
 * and must never read as "absent".
 */
const COMMON_PROCESSORS = [
  "Amazon Web Services",
  "AWS",
  "Google Cloud",
  "Google LLC",
  "Microsoft",
  "Azure",
  "Snowflake",
  "Datadog",
  "Salesforce",
  "Zendesk",
  "Stripe",
  "Twilio",
  "SendGrid",
  "Cloudflare",
  "Slack",
  "Atlassian",
  "Okta",
  "MongoDB",
  "Sentry",
  "Intercom",
  "HubSpot",
  "OpenAI",
  "Anthropic",
];
const MIN_COMMON_PROCESSORS = 3;

/** Trust-centre hosts a search hit may land on instead of the company's own domain. */
const TRUST_HOSTS = [
  /^trust\./,
  /\.safebase\.io$/,
  /\.vanta\.com$/,
  /\.trust\.page$/,
  /^app\.conveyor\.com$/,
  /\.whistic\.com$/,
  /\.drata\.com$/,
];

const JOB_BOARD_HOSTS = [
  /(^|\.)greenhouse\.io$/,
  /(^|\.)lever\.co$/,
  /(^|\.)ashbyhq\.com$/,
  /(^|\.)workable\.com$/,
];

/**
 * Words that put a mention on the company's own site in an engineering
 * context. Tool names are often ordinary words ("Backstage" is also a hotel
 * page on expedia.com), so a hit on the company's site needs one of these
 * beside the name; a job post is engineering context by being one.
 */
const ENGINEERING_CONTEXT = [
  "engineer",
  "engineers",
  "engineering",
  "developer",
  "developers",
  "platform",
  "portal",
  "plugin",
  "plugins",
  "open source",
  "open-source",
  "software",
  "devops",
  "infrastructure",
  "kubernetes",
  "catalog",
  "API",
  "SDK",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` names any of `names` as a whole word, ignoring case ("Exa" is not in "example"). */
export function namesAny(text: string, names: string[]): boolean {
  return names.some((n) => {
    const name = n.trim();
    if (!name) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}])`, "iu").test(
      text,
    );
  });
}

/** A real subprocessor list: says so, and names the processors such lists always name. */
export function isSubprocessorList(text: string): boolean {
  if (!/sub-?processors?/i.test(text)) return false;
  let common = 0;
  for (const p of COMMON_PROCESSORS) {
    if (namesAny(text, [p]) && ++common >= MIN_COMMON_PROCESSORS) return true;
  }
  return false;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function onDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return host === d || host.endsWith(`.${d}`);
}

function swallow(stage: string, err: unknown): void {
  logEvent(
    "error.swallowed",
    {
      kind: "list-page.verify",
      stage,
      message_120: ((err as Error)?.message ?? "").slice(0, 120),
    },
    "warn",
  );
}

async function fetchPage(url: string): Promise<{ url: string; text: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,text/plain" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, MAX_PAGE_CHARS);
    // A space before every tag: adjacent table cells otherwise run together
    // ("Amazon Web ServicesHosting") and no name matches as a whole word.
    return { url: res.url || url, text: htmlToText(html.replaceAll("<", " <")) };
  } catch {
    // unreachable path or host: one of many guesses, not an error worth logging
    return null;
  }
}

/** Judge one page's text: a list that names the vendor, a list that doesn't, or no list. */
function judgeList(
  page: { url: string; text: string },
  names: string[],
): SignalVerifyResult | null {
  if (!isSubprocessorList(page.text)) return null;
  return namesAny(page.text, names)
    ? { verdict: "confirmed", url: page.url, via: "subprocessors", costUsd: 0 }
    : { verdict: "absent", url: page.url, via: "subprocessors", costUsd: 0 };
}

async function checkSubprocessors(
  company: string,
  domain: string,
  names: string[],
): Promise<SignalVerifyResult> {
  // 1. Free: the paths these pages live at. A confirming page wins over a
  // list that leaves the vendor out (a regional or product-specific list).
  const urls = [
    ...SUBPROCESSOR_PATHS.map((p) => `https://${domain}${p}`),
    `https://trust.${domain.replace(/^www\./, "")}`,
  ];
  const pages = (await Promise.all(urls.map(fetchPage))).filter(
    (p): p is { url: string; text: string } => p !== null,
  );
  let absent: SignalVerifyResult | null = null;
  for (const page of pages) {
    const v = judgeList(page, names);
    if (v?.verdict === "confirmed") return v;
    if (v && !absent) absent = v;
  }
  if (absent) return absent;

  // 2. Paid: search for the page, then read it (a read renders script-built pages).
  let costUsd = 0;
  try {
    const search = await webSearch(
      { query: `"${company}" subprocessors`, maxResults: 5 },
      { playName: PLAY_NAME, memo: "list-page verify" },
    );
    costUsd += search.result.cost ?? 0;
    const kept = (search.result.results ?? []).filter((hit) => {
      const host = hit.url ? hostOf(hit.url) : null;
      return host !== null && (onDomain(host, domain) || TRUST_HOSTS.some((re) => re.test(host)));
    });
    for (const hit of kept) {
      if (namesAny(`${hit.title ?? ""} ${hit.description ?? ""}`, names)) {
        return { verdict: "confirmed", url: hit.url, via: "subprocessors", costUsd };
      }
    }
    const first = kept[0];
    if (first) {
      const read = await webRead(
        { url: first.url },
        { playName: PLAY_NAME, memo: "list-page verify" },
      );
      costUsd += read.result.cost ?? 0;
      const v = judgeList({ url: first.url, text: read.result.markdown ?? "" }, names);
      if (v) return { ...v, costUsd };
    }
  } catch (err) {
    swallow("subprocessors", err);
    return { verdict: "unknown", costUsd, errored: true };
  }
  return { verdict: "unknown", costUsd };
}

async function checkMentions(
  company: string,
  domain: string,
  names: string[],
): Promise<SignalVerifyResult> {
  const name = names[0]!.trim();
  const queries = [`"${name}" site:${domain}`, `"${company}" "${name}" engineer`];
  let costUsd = 0;
  let errored = false;
  for (const query of queries) {
    try {
      const search = await webSearch(
        { query, maxResults: 10 },
        { playName: PLAY_NAME, memo: "list-page verify" },
      );
      costUsd += search.result.cost ?? 0;
      for (const hit of search.result.results ?? []) {
        const host = hit.url ? hostOf(hit.url) : null;
        if (!host) continue;
        const own = onDomain(host, domain);
        // A job board hit must also be this company's posting.
        const job =
          JOB_BOARD_HOSTS.some((re) => re.test(host)) &&
          namesAny(`${hit.url} ${hit.title ?? ""}`, [company]);
        if (!own && !job) continue;
        const text = `${hit.title ?? ""} ${hit.description ?? ""}`;
        if (!namesAny(text, names)) continue;
        if (job || namesAny(`${hit.url} ${text}`, ENGINEERING_CONTEXT)) {
          return { verdict: "confirmed", url: hit.url, via: "mentions", costUsd };
        }
      }
    } catch (err) {
      swallow("mentions", err);
      errored = true;
    }
  }
  return errored ? { verdict: "unknown", costUsd, errored } : { verdict: "unknown", costUsd };
}

function cacheKey(domain: string, cfg: SignalVerifyConfig): string {
  const names = cfg.names
    .map((n) => n.trim().toLowerCase())
    .toSorted()
    .join("|");
  return `list-page-verify:${domain.toLowerCase()}:${names}:${cfg.via.toSorted().join("+")}`;
}

/**
 * The company's own evidence for the list's claim. Never throws: anything
 * that fails is "unknown", which the finder keeps (labelled unconfirmed).
 * Cached per domain and names for 30 days.
 */
export async function verifySignal(args: {
  company: string;
  domain: string;
  verify: SignalVerifyConfig;
}): Promise<SignalVerifyResult> {
  const { company, domain, verify } = args;
  const names = verify.names.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0 || verify.via.length === 0) return { verdict: "unknown", costUsd: 0 };
  const ledger = getLedger();
  const key = cacheKey(domain, verify);
  const cached = ledger.getProductResearchCache(key, CACHE_TTL_MS);
  if (cached) {
    try {
      const hit = JSON.parse(cached) as SignalVerifyResult;
      return { ...hit, costUsd: 0 };
    } catch {
      // corrupt entry: check again and overwrite
    }
  }

  let costUsd = 0;
  let errored = false;
  let outcome: SignalVerifyResult = { verdict: "unknown", costUsd: 0 };
  if (verify.via.includes("subprocessors")) {
    outcome = await checkSubprocessors(company, domain, names);
    costUsd += outcome.costUsd;
    errored ||= outcome.errored === true;
  }
  if (outcome.verdict === "unknown" && verify.via.includes("mentions")) {
    outcome = await checkMentions(company, domain, names);
    costUsd += outcome.costUsd;
    errored ||= outcome.errored === true;
  }
  const { errored: _e, ...rest } = outcome;
  const final: SignalVerifyResult = { ...rest, costUsd };
  // An "unknown" left by a failed call would stick for 30 days; check again next run.
  if (errored && final.verdict === "unknown") return { ...final, errored: true };
  try {
    ledger.setProductResearchCache(key, JSON.stringify(final));
  } catch (err) {
    swallow("cache", err);
  }
  return final;
}
