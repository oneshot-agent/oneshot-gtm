import { beforeEach, describe, expect, it, vi } from "vitest";

// The dossier route only reads caches: full research by the person key it was
// bought under, newsfeed posts by profile URL. It never buys anything.

const cache = new Map<string, { result_json: string; fetched_at: string; status: string | null }>();
const rows = new Map<number, { payload_json: string }>();
const ledger = {
  getQueueRow: vi.fn((id: number) => rows.get(id) ?? null),
  getCachedEnrichment: vi.fn((key: string) => cache.get(key) ?? null),
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, logEvent: () => {} };
});

const { buildQueueDossier, mergePosts, queueDossierRoute } =
  await import("../src/api/queue-dossier.ts");

const LI = "https://www.linkedin.com/in/ada-l";
const now = new Date().toISOString();

function research(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    status: "completed",
    result: {
      full_name: "Ada Lovelace",
      title: "Head of AI Platform",
      company: "Analytical Engines",
      summary: "Builds the platform every business unit ships agents on.",
      location: "London",
      linkedin_url: LI,
      emails: ["ada@engines.example"],
      altemails: ["ada@engines.example", "ada@home.example"],
      phones: [],
      skills: ["ML platforms", "Governance"],
      education: [{ school: "University of London", degree: "BSc", period: "1830 - 1833" }],
      experience: [
        { title: "Engineer", company: "Difference Co", period: "Jan 2019 - Dec 2022" },
        {
          title: "Head of AI Platform",
          company: "Analytical Engines",
          period: "Jan 2023 - Present",
        },
      ],
      recent_posts: [
        {
          url: "https://x.example/p/1",
          content: "Older post",
          posted_at: "2026-08-01T00:00:00Z",
          likes: 3,
        },
        {
          url: "https://x.example/p/2",
          content: "Shared by both",
          posted_at: "2026-09-01T00:00:00Z",
        },
      ],
      ...extra,
    },
  });
}

const payload = {
  email: "ada@engines.example",
  personResearch: {
    seed: { url: LI, email: "ada@engines.example" },
    researchedAt: "2026-09-01T00:00:00Z",
    bio: "short bio",
    organizations: [{ name: "Analytical Engines", title: "Head", current: true }],
    company: { name: "Analytical Engines", industry: "Computing", size: "201-500" },
    newsfeed: { url: LI, fetchedAt: now, count: 2 },
  },
};

beforeEach(() => {
  cache.clear();
  rows.clear();
});

describe("buildQueueDossier", () => {
  it("returns the full cached research, not the bounded summary", () => {
    cache.set(`person:${LI}`, { result_json: research(), fetched_at: now, status: null });
    const d = buildQueueDossier(payload);
    expect(d.status).toBe("complete");
    expect(d.person.summary).toBe("Builds the platform every business unit ships agents on.");
    expect(d.person.emails).toEqual(["ada@engines.example", "ada@home.example"]);
    expect(d.person.skills).toEqual(["ML platforms", "Governance"]);
    expect(d.education).toEqual([
      { school: "University of London", degree: "BSc", period: "1830 - 1833" },
    ]);
    expect(d.experience[0]).toMatchObject({ company: "Analytical Engines", current: true });
    expect(d.experience).toHaveLength(2);
    expect(d.company?.industry).toBe("Computing");
  });

  it("merges research posts with the newsfeed capture, deduped, newest first", () => {
    cache.set(`person:${LI}`, { result_json: research(), fetched_at: now, status: null });
    cache.set(`newsfeed:${LI}`, {
      result_json: JSON.stringify({
        result: [
          { url: "https://x.example/p/3", content: "Newest", posted_at: "2026-09-20T00:00:00Z" },
          {
            url: "https://x.example/p/2",
            content: "Shared by both",
            posted_at: "2026-09-01T00:00:00Z",
          },
          { content: "RT @someone: their words", posted_at: "2026-09-10T00:00:00Z" },
        ],
      }),
      fetched_at: now,
      status: null,
    });
    const d = buildQueueDossier(payload);
    expect(d.posts.map((p) => p.content)).toEqual([
      "Newest",
      "RT @someone: their words",
      "Shared by both",
      "Older post",
    ]);
    expect(d.posts[1]?.isRepost).toBe(true);
    expect(d.posts[2]?.source).toBe("newsfeed");
    expect(d.posts[3]?.source).toBe("research");
    expect(d.newsfeedFetchedAt).not.toBeNull();
  });

  it("falls back to the row's summary when the research is not cached", () => {
    const d = buildQueueDossier(payload);
    expect(d.status).toBe("summary-only");
    expect(d.person.summary).toBe("short bio");
    expect(d.experience).toEqual([
      {
        company: "Analytical Engines",
        title: "Head",
        startDate: null,
        endDate: null,
        current: true,
      },
    ]);
    expect(d.posts).toEqual([]);
  });

  it("ignores a failed research entry and finds research by email", () => {
    cache.set(`person:${LI}`, { result_json: "{}", fetched_at: now, status: "failed" });
    cache.set("person:ada@engines.example", {
      result_json: research(),
      fetched_at: now,
      status: null,
    });
    expect(buildQueueDossier(payload).person.fullName).toBe("Ada Lovelace");
  });

  it("says none when the row was never researched", () => {
    expect(buildQueueDossier({ email: "x@y.example" }).status).toBe("none");
  });
});

describe("mergePosts", () => {
  it("drops posts with neither url nor text", () => {
    expect(mergePosts([{ isRepost: false }], [])).toEqual([]);
  });
});

describe("queueDossierRoute", () => {
  const req = new Request("http://127.0.0.1/api/queue/1/dossier");
  it("404s an unknown row and 400s a bad id", async () => {
    expect(queueDossierRoute(req, { id: "7" }).status).toBe(404);
    expect(queueDossierRoute(req, { id: "abc" }).status).toBe(400);
  });

  it("returns the dossier for a row", async () => {
    rows.set(1, { payload_json: JSON.stringify(payload) });
    const res = queueDossierRoute(req, { id: "1" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("summary-only");
  });
});
