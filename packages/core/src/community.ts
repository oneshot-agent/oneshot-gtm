/** Public thread identity. Kept independent of finder and transport code. */
export type CommunityPlatform = "reddit" | "hacker-news";
export interface CommunityThread {
  platform: CommunityPlatform;
  threadId: string;
  postUrl: string;
  postTitle: string;
  handle: string;
  publishedAt: string;
  supportingText: string;
  retrievedAt: string;
}

export function communityUrl(
  raw: string,
): { platform: CommunityPlatform; threadId: string; postUrl: string } | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.hostname === "news.ycombinator.com" && u.pathname === "/item") {
      const id = u.searchParams.get("id");
      if (id && /^\d+$/.test(id))
        return {
          platform: "hacker-news",
          threadId: id,
          postUrl: `https://news.ycombinator.com/item?id=${id}`,
        };
    }
    if (/^(?:(?:www|old|new)\.)?reddit\.com$/.test(u.hostname)) {
      const id = u.pathname
        .match(/^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i)?.[1]
        ?.toLowerCase();
      if (id)
        return {
          platform: "reddit",
          threadId: id,
          postUrl: `https://www.reddit.com/comments/${id}/`,
        };
    }
  } catch {
    /* invalid source URL */
  }
  return null;
}

export function communityProfile(platform: CommunityPlatform, handle: string): string | null {
  if (platform === "reddit" && /^[a-z0-9_-]{3,20}$/i.test(handle) && handle !== "[deleted]")
    return `https://www.reddit.com/user/${handle.toLowerCase()}/`;
  if (platform === "hacker-news" && /^[a-z0-9_-]{1,32}$/i.test(handle))
    return `https://news.ycombinator.com/user?id=${encodeURIComponent(handle)}`;
  return null;
}

export function isCommunityPlatform(value: unknown): value is CommunityPlatform {
  return value === "reddit" || value === "hacker-news";
}

export function communityThread(value: unknown): CommunityThread | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  const url = typeof t.postUrl === "string" ? communityUrl(t.postUrl) : null;
  if (!url || url.platform !== t.platform || url.threadId !== t.threadId) return null;
  for (const key of ["postTitle", "handle", "publishedAt", "supportingText", "retrievedAt"])
    if (typeof t[key] !== "string" || !(t[key] as string).trim()) return null;
  if (
    !communityProfile(url.platform, t.handle as string) ||
    !Number.isFinite(Date.parse(t.publishedAt as string))
  )
    return null;
  return {
    ...url,
    postTitle: t.postTitle as string,
    handle: t.handle as string,
    publishedAt: t.publishedAt as string,
    supportingText: t.supportingText as string,
    retrievedAt: t.retrievedAt as string,
  };
}
