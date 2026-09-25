import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubUserInfo, TopRepo } from "../src/_github-user.ts";

let repos: TopRepo[] | null = [];
let readme: string | null = null;
const readmeCalls: string[] = [];

vi.mock("../src/_github-user.ts", () => ({
  fetchTopRepos: async () => repos,
}));
vi.mock("../src/_github-readme.ts", () => ({
  fetchProfileReadmeText: async (identity: { login: string }) => {
    readmeCalls.push(identity.login);
    return readme;
  },
}));

const { buildGitHubEvidence, readmeExcerpt, renderGitHubProfileLine, GITHUB_EVIDENCE_MAX_CHARS } =
  await import("../src/_github-evidence.ts");

function user(over: Partial<GitHubUserInfo> = {}): GitHubUserInfo {
  return {
    login: "ada",
    accountType: "User",
    name: "Ada",
    email: null,
    blogDomain: null,
    company: null,
    createdAt: "2020-01-01T00:00:00Z",
    publicRepos: 3,
    followers: 5,
    ...over,
  };
}

beforeEach(() => {
  repos = [];
  readme = null;
  readmeCalls.length = 0;
});

describe("renderGitHubProfileLine", () => {
  it("matches the angle evidence wording", () => {
    expect(
      renderGitHubProfileLine("ada", {
        name: "Ada",
        company: "Acme",
        blogDomain: "acme.dev",
        createdAt: "2020-01-01",
        publicRepos: 3,
        followers: 5,
      }),
    ).toBe(
      "Profile: Ada @ Acme (acme.dev) — account created 2020-01-01 — 3 public repos, 5 followers",
    );
  });
});

describe("buildGitHubEvidence", () => {
  it("includes bio, location and the person's own repos with recency and stars", async () => {
    repos = [
      {
        name: "agent-kit",
        description: "tools for agents that send email",
        language: "TypeScript",
        stars: 12,
        pushedAt: "2026-08-14T00:00:00Z",
      },
    ];
    const out = await buildGitHubEvidence(
      user({ bio: "Founder, building agent infra", location: "Berlin" }),
    );
    expect(out.text).toContain("Bio: Founder, building agent infra");
    expect(out.text).toContain("Location: Berlin");
    expect(out.text).toContain(
      "- agent-kit (TypeScript, ★12, pushed 2026-08) — tools for agents that send email",
    );
    expect(out.readReadme).toBe(false);
    expect(readmeCalls).toEqual([]);
  });

  it("reads the profile README only when the profile says nothing else", async () => {
    repos = [{ name: "dotfiles", description: null, language: null }];
    readme =
      "# Hi 👋\n[![badge](https://img.shields.io/x)](https://x)\nI build **voice agents** at [Acme](https://acme.dev).";
    const out = await buildGitHubEvidence(user());
    expect(readmeCalls).toEqual(["ada"]);
    expect(out.readReadme).toBe(true);
    expect(out.text).toContain("Profile README: Hi 👋 I build voice agents at Acme.");
    expect(out.text).not.toContain("shields.io");
  });

  it("uses pre-fetched repos without refetching and says so when there are none", async () => {
    const out = await buildGitHubEvidence(user({ bio: "x" }), { repos: [] });
    expect(out.text).toContain("Own repos: none public");
    expect(out.repos).toEqual([]);
  });

  it("caps the block", async () => {
    repos = Array.from({ length: 10 }, (_, i) => ({
      name: `repo-${i}`,
      description: "d".repeat(160),
      language: "Go",
    }));
    const out = await buildGitHubEvidence(user({ bio: "b".repeat(900) }));
    expect(out.text.length).toBeLessThanOrEqual(GITHUB_EVIDENCE_MAX_CHARS);
  });
});

describe("readmeExcerpt", () => {
  it("strips markup, badges, code and links down to prose", () => {
    const md =
      "<!-- hidden -->\n## About\n<img src='x.png'>\n```js\nconst a = 1\n```\nShipping [agents](https://a.dev) — see https://b.dev";
    expect(readmeExcerpt(md)).toBe("About Shipping agents — see");
  });

  it("truncates with an ellipsis", () => {
    expect(readmeExcerpt("word ".repeat(200), 20)).toHaveLength(20);
  });
});
