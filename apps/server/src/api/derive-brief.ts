import { logEvent, parallelMap, startRun, webRead, withDeadline } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import type { DeriveBriefResult } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

const PLAY_NAME = "config:brief";
/** Hard cap on sources per derive — each is one paid webRead (~$0.01). */
const MAX_SOURCES = 5;
/** webRead has been observed taking ~75s per page; parallel + a hard deadline keeps the button honest. */
const READ_DEADLINE_MS = 90_000;
/** Per-source slice fed to the LLM, so five long pages still fit a prompt. */
const PER_SOURCE_SLICE = 8000;

/**
 * Derive a product brief (facts + canonical links) from a set of source URLs —
 * the marketing site, the GitHub repo README, docs pages. Mirrors derive-icp
 * but multi-source, because the substance a reply needs (architecture, pricing
 * model, real doc links) usually lives in the repo and docs, not the landing
 * page. The proposal lands in the /setup textarea for the founder to edit
 * before saving — this endpoint never writes config.
 */
export async function deriveBriefRoute(req: Request): Promise<Response> {
  startRun();
  let body: { urls?: unknown } = {};
  try {
    body = (await req.json()) as { urls?: unknown };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  const rawUrls = Array.isArray(body.urls)
    ? body.urls.filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    : [];
  if (rawUrls.length === 0) {
    return jsonResponse({ error: "urls (string[]) required — at least one source" }, 400, req);
  }
  if (rawUrls.length > MAX_SOURCES) {
    return jsonResponse({ error: `at most ${MAX_SOURCES} sources per derive` }, 400, req);
  }

  const sourceUrls: string[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const sections: string[] = [];
  let costUsd = 0;

  // Parallel with a hard per-read deadline: webRead has been observed at ~75s
  // per page, and reading five sources sequentially would outlive any
  // reasonable button wait (the first live derive took 220s and the client
  // had long since given up).
  const reads = await parallelMap(rawUrls, MAX_SOURCES, async (raw) => {
    const url = normalizeToHttpsUrl(raw);
    if (!url) return { raw, url: null as string | null, error: "not a valid domain or URL" };
    const host = new URL(url).hostname;
    const startedAt = Date.now();
    try {
      const read = await withDeadline(
        webRead({ url }, { playName: PLAY_NAME }),
        READ_DEADLINE_MS,
        `webRead ${host}`,
      );
      const markdown = (read.result.markdown ?? "").trim();
      const c = (read.result as unknown as { cost?: number }).cost;
      logEvent("derive_brief.read.done", {
        host,
        duration_ms: Date.now() - startedAt,
        markdown_chars: markdown.length,
      });
      return { raw, url, markdown, cost: typeof c === "number" ? c : 0, error: null };
    } catch (err) {
      // One unreachable source must not sink the derive — report it and move on.
      logEvent(
        "derive_brief.read.error",
        { host, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      return { raw, url, error: ((err as Error).message ?? "read failed").slice(0, 120) };
    }
  });

  for (const r of reads) {
    if (!r.url) {
      skipped.push({ url: r.raw, reason: r.error ?? "invalid" });
      continue;
    }
    if (r.error != null || !("markdown" in r)) {
      skipped.push({ url: r.url, reason: r.error ?? "read failed" });
      continue;
    }
    costUsd += r.cost ?? 0;
    if ((r.markdown ?? "").length < 80) {
      skipped.push({ url: r.url, reason: `too little content (${r.markdown!.length} chars)` });
      continue;
    }
    sourceUrls.push(r.url);
    sections.push(`SOURCE: ${r.url}\n\n${r.markdown!.slice(0, PER_SOURCE_SLICE)}`);
  }

  if (sections.length === 0) {
    return jsonResponse({ error: "none of the sources could be read", skipped, costUsd }, 422, req);
  }

  let proposed = "";
  try {
    const llm = await complete({
      messages: [
        { role: "system", content: loadPrompt("derive-brief") },
        { role: "user", content: sections.join("\n\n=====\n\n") },
      ],
      temperature: 0.2,
      maxTokens: 700,
    });
    proposed = llm.content.trim();
  } catch (err) {
    return jsonResponse({ error: `LLM call failed: ${(err as Error).message}` }, 502, req);
  }

  logEvent("derive_brief.done", {
    sources: sourceUrls.length,
    skipped: skipped.length,
    cost_usd: costUsd,
    response_chars: proposed.length,
  });
  const view: DeriveBriefResult = { proposedBrief: proposed, sourceUrls, skipped, costUsd };
  return jsonResponse(view, 200, req);
}

/** Same normalization as derive-icp: bare domain, host or full URL → https URL. */
function normalizeToHttpsUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/^https?:\/\//, "");
  const candidate = `https://${trimmed.replace(/^\/+/, "")}`;
  try {
    const u = new URL(candidate);
    if (!u.hostname.includes(".")) return null;
    if (/^[0-9.]+$/.test(u.hostname)) return null;
    if (u.hostname === "localhost") return null;
    return u.toString();
  } catch {
    return null;
  }
}
