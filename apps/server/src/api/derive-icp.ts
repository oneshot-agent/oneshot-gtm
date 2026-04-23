import { webRead } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import type { DeriveIcpResult } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

const PLAY_NAME = "config:icp";

export async function deriveIcpRoute(req: Request): Promise<Response> {
  let body: { domain?: unknown } = {};
  try {
    body = (await req.json()) as { domain?: unknown };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  if (typeof body.domain !== "string" || body.domain.trim().length === 0) {
    return jsonResponse({ error: "domain (string) required" }, 400, req);
  }

  const url = normalizeToHttpsUrl(body.domain);
  if (!url) {
    return jsonResponse({ error: `not a valid domain or URL: ${body.domain}` }, 400, req);
  }

  let costUsd = 0;
  let markdown = "";
  try {
    const read = await webRead({ url }, { playName: PLAY_NAME });
    markdown = (read.result.markdown ?? "").trim();
    const c = (read.result as unknown as { cost?: number }).cost;
    if (typeof c === "number") costUsd += c;
  } catch (err) {
    return jsonResponse(
      { error: `webRead failed for ${url}: ${(err as Error).message}` },
      502,
      req,
    );
  }

  if (markdown.length < 80) {
    return jsonResponse(
      {
        error: `not enough page content to derive an ICP from ${url} (got ${markdown.length} chars). Try a more specific page (pricing, customers, about).`,
      },
      422,
      req,
    );
  }

  const system = loadPrompt("icp-derive-from-site");
  let proposed = "";
  try {
    const llm = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: markdown.slice(0, 12000) },
      ],
      temperature: 0.2,
      maxTokens: 200,
    });
    proposed = llm.content.trim().replace(/^["']|["']$/g, "");
  } catch (err) {
    return jsonResponse({ error: `LLM call failed: ${(err as Error).message}` }, 502, req);
  }

  if (proposed.toLowerCase().startsWith("unable to derive")) {
    return jsonResponse(
      { error: proposed, sourceUrl: url, costUsd },
      422,
      req,
    );
  }

  const view: DeriveIcpResult = {
    proposedIcp: proposed,
    sourceUrl: url,
    costUsd,
  };
  return jsonResponse(view, 200, req);
}

/**
 * Accepts a bare domain ("acme.com"), a host with subdomain ("blog.acme.com"),
 * or a full URL. Always returns an https:// URL. Rejects anything that doesn't
 * parse as a valid hostname.
 */
function normalizeToHttpsUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/^https?:\/\//, "");
  // Strip trailing slashes for the bare-host case so URL doesn't choke.
  const candidate = `https://${trimmed.replace(/^\/+/, "")}`;
  try {
    const u = new URL(candidate);
    // Defense: hostname must contain at least one dot and look like a real
    // public host. Reject localhost / IPs / single-label hosts.
    if (!u.hostname.includes(".")) return null;
    if (/^[0-9.]+$/.test(u.hostname)) return null;
    if (u.hostname === "localhost") return null;
    return u.toString();
  } catch {
    return null;
  }
}
