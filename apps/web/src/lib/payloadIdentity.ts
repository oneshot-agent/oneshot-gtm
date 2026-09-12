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

/**
 * The person research the post-finder step stamps on a row (current role from
 * the public work history). Mirrors `PersonResearchDossier` in core without
 * importing it: the web app reads payloads as untyped JSON, so a shape check
 * is the contract.
 */
export interface PersonResearchView {
  version: 1;
  status: "complete" | "partial" | "unavailable";
  researchedAt: string;
  currentRole?: { title?: string; company: string; since?: string };
  organizations: Array<{
    name: string;
    title?: string;
    startDate?: string;
    endDate?: string;
    current: boolean;
  }>;
  company?: {
    name?: string;
    industry?: string;
    size?: string;
    employeeCount?: number;
    founded?: string | number;
    fundingStage?: string;
    description?: string;
  };
}

export function personResearchFor(payload: unknown): PersonResearchView | null {
  const p = record(payload);
  const v = p?.["personResearch"];
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r["version"] !== 1 || !Array.isArray(r["organizations"])) return null;
  if (r["status"] !== "complete" && r["status"] !== "partial" && r["status"] !== "unavailable") {
    return null;
  }
  if (typeof r["researchedAt"] !== "string") return null;
  const role = r["currentRole"];
  if (role && typeof role === "object" && !Array.isArray(role)) {
    const company = (role as Record<string, unknown>)["company"];
    if (typeof company !== "string" || company.trim() === "") {
      // A role with no company would render "Founder at undefined".
      const { currentRole: _dropped, ...rest } = r;
      return rest as unknown as PersonResearchView;
    }
  }
  return v as PersonResearchView;
}

function stringAt(payload: unknown, key: string): string | null {
  const p = record(payload);
  const v = p?.[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** The finder's title before research corrected it; null when it never changed. */
export function titleAtFinderFor(payload: unknown): string | null {
  return stringAt(payload, "titleAtFinder");
}

/** The finder's company before research corrected it; null when it never changed. */
export function companyAtFinderFor(payload: unknown): string | null {
  return stringAt(payload, "companyAtFinder");
}
