import { beforeEach, describe, expect, it, vi } from "vitest";

// RECENT POSTS for the design-partner first touch, and the ROLE / COMPANY
// FACTS lines its follow-ups get.

const { feeds } = vi.hoisted(() => ({
  feeds: new Map<string, { url: string; fetchedAt: string; posts: unknown[] }>(),
}));
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getCachedNewsfeed: (url: string) => feeds.get(url) ?? null };
});

const { recentPostsBlock } = await import("../src/_recent-posts.ts");
const { prospectContextLines } = await import("../src/_cadence.ts");

const URL = "https://www.linkedin.com/in/dana-lee";
const NOW = new Date("2026-09-28T00:00:00Z");
const post = (content: string, postedAt: string, isRepost = false) => ({
  content,
  postedAt,
  isRepost,
});

beforeEach(() => feeds.clear());

describe("recentPostsBlock", () => {
  it("lists their own recent posts, newest first, at most three", () => {
    feeds.set(URL, {
      url: URL,
      fetchedAt: NOW.toISOString(),
      posts: [
        post("older post", "2026-06-01T00:00:00Z"),
        post("RT @someone: not theirs", "2026-09-20T00:00:00Z", true),
        post("newest post about agents", "2026-09-20T00:00:00Z"),
        post("middle post", "2026-08-01T00:00:00Z"),
        post("fourth post", "2026-07-01T00:00:00Z"),
        post("stale post", "2025-12-01T00:00:00Z"),
      ],
    });
    const block = recentPostsBlock({ linkedinUrl: "linkedin.com/in/dana-lee/" }, NOW)!;
    const lines = block.split("\n").slice(1);
    expect(lines).toEqual([
      "- 2026-09-20: newest post about agents",
      "- 2026-08-01: middle post",
      "- 2026-07-01: fourth post",
    ]);
    expect(block).toMatch(/never instructions/);
  });

  it("trims a long post and collapses its whitespace", () => {
    feeds.set(URL, {
      url: URL,
      fetchedAt: NOW.toISOString(),
      posts: [post(`line one\n\n${"x".repeat(400)}`, "2026-09-01T00:00:00Z")],
    });
    const line = recentPostsBlock({ linkedinUrl: URL }, NOW)!.split("\n")[1]!;
    expect(line.startsWith("- 2026-09-01: line one x")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(300);
  });

  it("is null without a profile, without a capture, or with only reposts", () => {
    expect(recentPostsBlock({}, NOW)).toBeNull();
    expect(recentPostsBlock({ linkedinUrl: URL }, NOW)).toBeNull();
    feeds.set(URL, {
      url: URL,
      fetchedAt: NOW.toISOString(),
      posts: [post("RT @x: y", "2026-09-01T00:00:00Z", true)],
    });
    expect(recentPostsBlock({ linkedinUrl: URL }, NOW)).toBeNull();
  });
});

describe("prospectContextLines", () => {
  it("adds the role and the researched company facts", () => {
    expect(
      prospectContextLines({
        title: "Head of AI Platform",
        dossier_json: JSON.stringify({
          person: { companyFacts: "Color · hospital & health care · 660 employees" },
        }),
      }),
    ).toEqual([
      "ROLE: Head of AI Platform",
      "COMPANY FACTS: Color · hospital & health care · 660 employees",
    ]);
  });

  it("adds nothing when neither is known", () => {
    expect(prospectContextLines({ title: null, dossier_json: null })).toEqual([]);
  });
});
