import { beforeEach, describe, expect, it, vi } from "vitest";

// The re-judge runs against the real (temp-home) ledger; only GitHub and the
// classifiers are stubbed.
let icpMatch: boolean | null = true;
let personVerdict: "pass" | "reject" | "unclear" | "transient" = "pass";
let userAvailable = true;
const icpSummaries: string[] = [];

vi.mock("../src/_github-user.ts", () => ({
  fetchGitHubUser: async (login: string) =>
    userAvailable
      ? {
          login,
          accountType: "User",
          name: `${login} name`,
          email: null,
          blogDomain: null,
          company: "Acme",
          bio: "Building agent infra",
          createdAt: "2020-01-01T00:00:00Z",
          publicRepos: 4,
          followers: 9,
        }
      : null,
  fetchTopRepos: async () => [{ name: "kit", description: "agent kit", language: "Go" }],
}));
vi.mock("../src/_github-readme.ts", () => ({ fetchProfileReadmeText: async () => null }));
vi.mock("../src/_filter.ts", () => ({
  resolveIcp: () => "icp",
  icpFilter: async (args: { candidate: { summary?: string } }) => {
    icpSummaries.push(args.candidate.summary ?? "");
    return { match: icpMatch, reason: icpMatch ? "builds agents" : "not a builder" };
  },
  qualifyPerson: async () => ({ verdict: personVerdict, reason: "role stub" }),
}));

const { getLedger } = await import("@oneshot-gtm/core");
const { rejudgeGitHubStarsRows } = await import("../src/github-rejudge.ts");
const { githubStarsLogin } = await import("../src/queue-contact.ts");

let seq = 0;
function seed(status: "pending" | "approved", payload: Record<string, unknown> = {}): number {
  const login = `user${++seq}`;
  const id = getLedger().enqueueTarget({
    playName: "repo-interest",
    payload: { name: login, repo: "org/repo", ...payload },
    dedupeKey: `github-stars:org/repo:${login}`,
    source: "find:github-stars:org/repo",
    initialStatus: status,
    notes: "auto: ICP — a single star is insufficient evidence",
  });
  if (id == null) throw new Error("seed failed");
  return id;
}
const row = (id: number) => getLedger().getQueueRow(id)!;
const payload = (id: number) => JSON.parse(row(id).payload_json) as Record<string, unknown>;

beforeEach(() => {
  icpMatch = true;
  personVerdict = "pass";
  userAvailable = true;
  icpSummaries.length = 0;
});

describe("githubStarsLogin", () => {
  it("reads the login from source + dedupe key and refuses mismatches", () => {
    expect(
      githubStarsLogin({
        source: "find:github-stars:org/repo",
        dedupe_key: "github-stars:org/repo:ada",
      }),
    ).toBe("ada");
    expect(
      githubStarsLogin({
        source: "find:github-stars:org/repo",
        dedupe_key: "github-stars:x/y:ada",
      }),
    ).toBeNull();
    expect(githubStarsLogin({ source: "find:luma-events", dedupe_key: "whatever" })).toBeNull();
  });
});

describe("rejudgeGitHubStarsRows", () => {
  it("judges on the GitHub evidence and writes the verdict", async () => {
    const id = seed("pending");
    const res = await rejudgeGitHubStarsRows({ id });
    expect(res).toMatchObject({ judged: 1, pass: 1, statusChanged: 0 });
    expect(icpSummaries[0]).toContain("Bio: Building agent infra");
    expect(icpSummaries[0]).toContain("Starred: org/repo");
    expect(payload(id)).toMatchObject({ icpVerdict: "pass", icpVerdictReason: "builds agents" });
    expect(payload(id)["githubEvidence"]).toContain("- kit (Go) — agent kit");
    expect(row(id).status).toBe("pending");
  });

  it("moves a failing pending row to rejected", async () => {
    icpMatch = false;
    const id = seed("pending");
    await rejudgeGitHubStarsRows({ id });
    expect(row(id).status).toBe("rejected");
    expect(row(id).notes).toContain("re-judged from GitHub: not a builder");
  });

  it("only annotates a failing approved row unless rejectApproved is set", async () => {
    icpMatch = false;
    const kept = seed("approved");
    await rejudgeGitHubStarsRows({ id: kept });
    expect(row(kept).status).toBe("approved");
    expect(row(kept).notes).toContain("re-judged from GitHub: not a builder");

    const moved = seed("approved");
    const res = await rejudgeGitHubStarsRows({ id: moved, rejectApproved: true });
    expect(res.statusChanged).toBe(1);
    expect(row(moved).status).toBe("rejected");
  });

  it("lets the person gate reject an emailed, bio'd pass", async () => {
    personVerdict = "reject";
    const id = seed("approved", { email: "a@b.dev" });
    await rejudgeGitHubStarsRows({ id, rejectApproved: true });
    expect(payload(id)).toMatchObject({ icpVerdict: "reject", icpVerdictReason: "role stub" });
    expect(row(id).status).toBe("rejected");
  });

  it("skips, never rejects, on a transient GitHub or classifier failure", async () => {
    userAvailable = false;
    const a = seed("pending");
    icpMatch = null;
    const res1 = await rejudgeGitHubStarsRows({ id: a });
    expect(res1.skipped).toBe(1);
    userAvailable = true;
    const res2 = await rejudgeGitHubStarsRows({ id: a });
    expect(res2.skipped).toBe(1);
    expect(row(a).status).toBe("pending");
    expect(payload(a)["icpVerdict"]).toBeUndefined();
  });

  it("writes nothing on a dry run", async () => {
    icpMatch = false;
    const id = seed("pending");
    const res = await rejudgeGitHubStarsRows({ id, dryRun: true });
    expect(res.reject).toBe(1);
    expect(row(id).status).toBe("pending");
    expect(payload(id)["icpVerdict"]).toBeUndefined();
  });

  it("selects github-stars rows oldest first and skips already re-judged ones", async () => {
    const first = seed("approved");
    const second = seed("approved");
    await rejudgeGitHubStarsRows({ id: first });
    const seen: number[] = [];
    await rejudgeGitHubStarsRows({ status: "approved", limit: 50, onRow: (r) => seen.push(r.id) });
    expect(seen).not.toContain(first);
    expect(seen).toContain(second);
    expect(seen).toEqual(seen.toSorted((a, b) => a - b));
  });
});
