/**
 * Who a queue row is about, read from the finder's payload. Every finder
 * writes a slightly different shape (`name` vs `founderName`, `email` vs
 * `founderEmail`), and a pre-enrichment reject may carry only a source URL,
 * so these readers are the one place that knows the fallbacks. Shared by
 * /queue and /prospects so the same row reads the same on both pages.
 *
 * Pure and total: a missing key or a payload of the wrong shape returns null.
 */

function record(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

export function emailFor(payload: unknown): string | null {
  const p = record(payload);
  if (!p) return null;
  if (typeof p["email"] === "string") return p["email"] as string;
  if (typeof p["founderEmail"] === "string") return p["founderEmail"] as string;
  return null;
}

export function nameFor(payload: unknown): string | null {
  const p = record(payload);
  if (!p) return null;
  if (typeof p["name"] === "string") return p["name"] as string;
  if (typeof p["founderName"] === "string") return p["founderName"] as string;
  // Pre-enrichment rejected rows only carry a source URL — derive a handle.
  const repoUrl = typeof p["repoUrl"] === "string" ? (p["repoUrl"] as string) : null;
  if (repoUrl) {
    const m = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  const postUrl = typeof p["postUrl"] === "string" ? (p["postUrl"] as string) : null;
  if (postUrl) {
    try {
      const host = new URL(postUrl).hostname.replace(/^www\./, "");
      if (host) return host;
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * The finder-specific tail of `source` ("find:github-stars:vercel/eve" ->
 * "vercel/eve") — which repo / cohort matched. Empty when source is just the
 * finder name (fully redundant with the play column).
 */
export function sourceDetail(source: string | null | undefined): string {
  if (!source) return "";
  return source.split(":").slice(2).join(":");
}

export function companyFor(payload: unknown): string | null {
  const p = record(payload);
  if (!p) return null;
  if (typeof p["company"] === "string") return p["company"] as string;
  return null;
}

// Stamped on the payload by the person-level ICP gate; absent on rows queued
// before the gate existed.
export function titleFor(payload: unknown): string | null {
  const p = record(payload);
  if (!p) return null;
  const v = p["title"];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function linkedinUrlFor(payload: unknown): string | null {
  const p = record(payload);
  if (!p) return null;
  const v = p["linkedinUrl"];
  if (typeof v !== "string" || v.length === 0) return null;
  // Defense in depth — payload comes from sqlite but a stale/garbage row should
  // never render as a clickable javascript:// or data:// link.
  return /^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\//i.test(v) ? v : null;
}

export function phoneFor(payload: unknown): string | null {
  const p = record(payload);
  if (!p) return null;
  const v = p["phone"];
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}
