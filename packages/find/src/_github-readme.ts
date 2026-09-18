import { logEvent } from "@oneshot-gtm/core";
import { githubHeaders } from "./_github-search.ts";

export interface GitHubIdentity {
  login: string;
  accountType?: string | null;
}
export interface EmailSource {
  kind: "github-profile-readme";
  url: string;
  resolvedAt: string;
}
type ReadmeResult =
  | { status: "found"; email: string; url: string }
  | { status: "missing" | "ambiguous" | "unavailable" };
const cache = new Map<string, { expires: number; result: ReadmeResult }>();
const pending = new Map<string, Promise<ReadmeResult>>();
const LIMIT = 64 * 1024;
export function _resetReadmeCache(): void {
  cache.clear();
  pending.clear();
}

/** Deliberately conservative: explicit self-contact only, never inferred addresses. */
export function extractReadmeEmail(markdown: string): ReadmeResult {
  const clean = markdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\((?!mailto:)[^)]*\)/gi, "$1")
    .replace(/<a\b([^>]*)>[\s\S]*?<\/a>/gi, (link, attrs: string) =>
      /href\s*=\s*["']mailto:/i.test(attrs) ? link : " ",
    )
    .replace(/https?:\/\/[^\s<>")]+/gi, " ");
  const emails = new Set<string>();
  let excludedDepth: number | null = null;
  let fence: string | null = null;
  for (const rawLine of clean.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(rawLine)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(rawLine)) continue;
    const line = rawLine.replace(/`[^`\n]*`/g, "");
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      if (excludedDepth !== null && depth <= excludedDepth) excludedDepth = null;
      if (/contributors?|credits?|examples?|support|team|sponsors?/i.test(line))
        excludedDepth = depth;
    }
    if (
      excludedDepth !== null ||
      /\b(contributors?|example|support|team|noreply|no-reply|sponsor)\b/i.test(line)
    )
      continue;
    const contact =
      /\b(contact me|reach me|email me|my email|e-mail me)\b/i.test(line) ||
      /(?:\[|<a\b[^>]*>)\s*(?:email|e-mail|contact)(?: me)?\s*(?:\]|<\/a>)/i.test(line) ||
      /^\s*(?:[-*]\s*)?(?:email|e-mail)\s*:/i.test(line);
    if (!contact) continue;
    for (const match of line.matchAll(
      /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi,
    )) {
      const email = match[0].toLowerCase();
      if (
        /^(?:support|team|hello|info|contact|sales|noreply|no-reply)@/.test(email) ||
        /@(?:example\.(?:com|org|net)|[^@]+\.example)$/.test(email)
      )
        continue;
      emails.add(email);
    }
  }
  if (emails.size > 1) return { status: "ambiguous" };
  const email = [...emails][0];
  return email ? { status: "found", email, url: "" } : { status: "missing" };
}

async function limitedText(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > LIMIT) throw new Error("oversized");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) throw new Error("oversized");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

async function readProfile(login: string): Promise<ReadmeResult> {
  const base = `https://api.github.com/repos/${login}/${login}`;
  const signal = AbortSignal.timeout(10_000);
  const headers = githubHeaders();
  try {
    const repo = await fetch(base, { headers, signal, redirect: "error" });
    if (repo.status === 404) return { status: "missing" };
    if (!repo.ok) return { status: "unavailable" };
    const metadata = JSON.parse(await limitedText(repo));
    if (metadata.private !== false) return { status: "missing" };
    const readme = await fetch(`${base}/readme`, {
      headers: { ...headers, Accept: "application/vnd.github.raw+json" },
      signal,
      redirect: "error",
    });
    if (readme.status === 404) return { status: "missing" };
    if (!readme.ok) return { status: "unavailable" };
    const result = extractReadmeEmail(await limitedText(readme));
    return result.status === "found"
      ? { ...result, url: `https://github.com/${login}/${login}#readme` }
      : result;
  } catch {
    return { status: "unavailable" };
  }
}

export async function fetchProfileReadmeEmail(identity: GitHubIdentity): Promise<ReadmeResult> {
  if (identity.accountType !== "User" || !/^[a-zA-Z0-9-]{1,39}$/.test(identity.login)) {
    return { status: "missing" };
  }
  const login = identity.login.toLowerCase();
  const saved = cache.get(login);
  if (saved && saved.expires > Date.now()) {
    logEvent("github.readme.contact", { login, status: saved.result.status, cached: true });
    return saved.result;
  }
  const inFlight = pending.get(login);
  if (inFlight) return inFlight;
  const request = readProfile(login)
    .then((result) => {
      if (result.status !== "unavailable")
        cache.set(login, { result, expires: Date.now() + 86_400_000 });
      logEvent("github.readme.contact", { login, status: result.status, cached: false });
      return result;
    })
    .finally(() => pending.delete(login));
  pending.set(login, request);
  return request;
}
