import { describe, expect, it } from "vitest";
import { looksLikeNoiseRepo, normalizeRepoUrl } from "../src/_repo-utils.ts";

describe("looksLikeNoiseRepo", () => {
  it("rejects awesome-lists, tutorials, examples, demos, courses", () => {
    expect(looksLikeNoiseRepo("https://github.com/sindresorhus/awesome-ai")).toBe(true);
    expect(looksLikeNoiseRepo("https://github.com/foo/awesome_agents")).toBe(true);
    expect(looksLikeNoiseRepo("https://github.com/foo/bar-awesome")).toBe(true);
    expect(looksLikeNoiseRepo("https://github.com/foo/langchain-tutorial")).toBe(true);
    expect(looksLikeNoiseRepo("https://github.com/foo/agent-examples")).toBe(true);
    expect(looksLikeNoiseRepo("https://github.com/foo/demo-agent")).toBe(true);
    expect(looksLikeNoiseRepo("https://github.com/foo/ai-course")).toBe(true);
    expect(looksLikeNoiseRepo("https://github.com/foo/nextjs-boilerplate")).toBe(true);
  });

  it("matches case-insensitively (GitHub repo names are case-preserving)", () => {
    expect(looksLikeNoiseRepo("https://github.com/FOO/Awesome-AI")).toBe(true);
    expect(looksLikeNoiseRepo("https://github.com/foo/LangChain-TUTORIAL")).toBe(true);
    expect(looksLikeNoiseRepo("https://github.com/foo/Demo-Agent")).toBe(true);
  });

  it("accepts real product repo names", () => {
    expect(looksLikeNoiseRepo("https://github.com/anthropics/anthropic-sdk-typescript")).toBe(
      false,
    );
    expect(looksLikeNoiseRepo("https://github.com/acme/ops-copilot")).toBe(false);
    expect(looksLikeNoiseRepo("https://github.com/seed-ai/letterhead")).toBe(false);
  });

  it("does not confuse substrings inside the middle of the repo name", () => {
    expect(looksLikeNoiseRepo("https://github.com/foo/lawsome")).toBe(false);
    expect(looksLikeNoiseRepo("https://github.com/foo/courseplot")).toBe(false);
  });
});

describe("normalizeRepoUrl", () => {
  it("keeps canonical github.com/user/repo form", () => {
    expect(normalizeRepoUrl("https://github.com/acme/foo")).toBe("https://github.com/acme/foo");
  });

  it("accepts http:// as well as https://", () => {
    expect(normalizeRepoUrl("http://github.com/acme/foo")).toBe("https://github.com/acme/foo");
  });

  it("matches the host case-insensitively", () => {
    expect(normalizeRepoUrl("https://GITHUB.COM/acme/foo")).toBe("https://github.com/acme/foo");
    expect(normalizeRepoUrl("https://GitHub.com/acme/foo")).toBe("https://github.com/acme/foo");
  });

  it("accepts www.github.com", () => {
    expect(normalizeRepoUrl("https://www.github.com/acme/foo")).toBe("https://github.com/acme/foo");
  });

  it("strips deeper paths and .git suffix", () => {
    expect(normalizeRepoUrl("https://github.com/acme/foo/blob/main/README.md")).toBe(
      "https://github.com/acme/foo",
    );
    expect(normalizeRepoUrl("https://github.com/acme/foo.git")).toBe("https://github.com/acme/foo");
    expect(normalizeRepoUrl("https://github.com/acme/foo.GIT")).toBe("https://github.com/acme/foo");
  });

  it("drops query strings and fragments", () => {
    expect(normalizeRepoUrl("https://github.com/acme/foo?tab=readme")).toBe(
      "https://github.com/acme/foo",
    );
    expect(normalizeRepoUrl("https://github.com/acme/foo#readme")).toBe(
      "https://github.com/acme/foo",
    );
  });

  it("rejects non-GitHub, missing-segment, and malformed URLs", () => {
    expect(normalizeRepoUrl("https://gitlab.com/acme/foo")).toBeNull();
    expect(normalizeRepoUrl("https://github.com/acme")).toBeNull();
    expect(normalizeRepoUrl("https://github.com/")).toBeNull();
    expect(normalizeRepoUrl("not a url")).toBeNull();
    expect(normalizeRepoUrl(null)).toBeNull();
    expect(normalizeRepoUrl(undefined)).toBeNull();
    expect(normalizeRepoUrl("")).toBeNull();
  });

  it("rejects gist, raw content, and every reserved non-repo path prefix", () => {
    expect(normalizeRepoUrl("https://gist.github.com/acme/abc123")).toBeNull();
    expect(
      normalizeRepoUrl("https://raw.githubusercontent.com/acme/foo/main/README.md"),
    ).toBeNull();
    for (const path of [
      "topics/ai",
      "orgs/anthropic/repositories",
      "marketplace/actions/foo",
      "trending/python",
      "sponsors/acme",
      "enterprise",
      "pricing",
      "features/copilot",
      "explore",
      "search?q=foo",
    ]) {
      expect(normalizeRepoUrl(`https://github.com/${path}`)).toBeNull();
    }
  });
});
