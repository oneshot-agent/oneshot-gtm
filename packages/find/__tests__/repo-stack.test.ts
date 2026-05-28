import { afterEach, describe, expect, it } from "vitest";
import { detectRepoStack, namesFromManifest } from "../src/_repo-stack.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Mock global fetch with a per-URL response map. Unmatched URLs return 404. */
function mockFetchByUrl(map: Record<string, { status?: number; body?: string }>): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    for (const [key, resp] of Object.entries(map)) {
      if (url.includes(key)) {
        return new Response(resp.body ?? "", { status: resp.status ?? 200 });
      }
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("namesFromManifest — package.json", () => {
  it("pulls dependencies + devDependencies + peerDependencies", () => {
    const out = namesFromManifest(
      "package.json",
      JSON.stringify({
        name: "agent",
        dependencies: { openai: "^1.0", "@anthropic-ai/sdk": "^0.30" },
        devDependencies: { vitest: "^1.0" },
        peerDependencies: { react: "^19.0" },
      }),
    );
    expect(out.toSorted()).toEqual(["@anthropic-ai/sdk", "openai", "react", "vitest"]);
  });

  it("returns [] on malformed JSON", () => {
    expect(namesFromManifest("package.json", "{not json")).toEqual([]);
  });

  it("returns [] when no dependency sections present", () => {
    expect(namesFromManifest("package.json", JSON.stringify({ name: "agent" }))).toEqual([]);
  });

  it("tolerates a top-level array (not an object)", () => {
    expect(namesFromManifest("package.json", JSON.stringify([1, 2]))).toEqual([]);
  });
});

describe("namesFromManifest — pyproject.toml", () => {
  it("extracts Poetry-style deps", () => {
    const content = `
[tool.poetry.dependencies]
python = "^3.11"
openai = "^1.0"
twilio = "^9.0"
anthropic = { version = "^0.30" }
`;
    const out = namesFromManifest("pyproject.toml", content);
    // Strict subset — the regex catches more than just deps but the names we
    // care about are present.
    expect(out).toContain("openai");
    expect(out).toContain("twilio");
    expect(out).toContain("anthropic");
  });

  it("extracts PEP 621-style dependencies array", () => {
    const content = `
[project]
name = "agent"
dependencies = ["openai>=1.0", "twilio==9.0", "langchain", "tavily-python>=0.3"]
`;
    const out = namesFromManifest("pyproject.toml", content);
    expect(out).toContain("openai");
    expect(out).toContain("twilio");
    expect(out).toContain("langchain");
    expect(out).toContain("tavily-python");
  });

  it("filters out the reserved top-level pyproject keys (name, version, etc.)", () => {
    const content = `
name = "agent"
version = "0.1.0"
description = "an agent"
[project]
requires-python = ">=3.11"
dependencies = ["openai"]
`;
    const out = namesFromManifest("pyproject.toml", content);
    expect(out).not.toContain("name");
    expect(out).not.toContain("version");
    expect(out).not.toContain("description");
    expect(out).not.toContain("requires-python");
    expect(out).toContain("openai");
  });
});

describe("namesFromManifest — requirements.txt", () => {
  it("extracts the package name from each line, ignoring version specifiers", () => {
    const content = [
      "openai==1.0.0",
      "twilio>=9.0",
      "anthropic~=0.30",
      "langchain>=0.1,<1.0",
      "playwright[chromium]==1.40.0",
    ].join("\n");
    const out = namesFromManifest("requirements.txt", content);
    expect(out).toEqual(["openai", "twilio", "anthropic", "langchain", "playwright"]);
  });

  it("ignores comments, blank lines, and pip flags", () => {
    const content = `
# top comment
--index-url https://pypi.org/simple

openai
    # indented comment line
twilio
-e git+https://github.com/foo/bar.git#egg=bar
`;
    const out = namesFromManifest("requirements.txt", content);
    expect(out).toEqual(["openai", "twilio"]);
  });
});

describe("namesFromManifest — .env.example", () => {
  it("extracts the env-var keys (left of =)", () => {
    const content = `
# Comment
OPENAI_API_KEY=sk-XXX
TWILIO_ACCOUNT_SID=ACXXX
TWILIO_AUTH_TOKEN=
SENDGRID_API_KEY="SG.xxx"
`;
    const out = namesFromManifest(".env.example", content);
    expect(out).toEqual([
      "OPENAI_API_KEY",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "SENDGRID_API_KEY",
    ]);
  });

  it("ignores blank lines and comments", () => {
    expect(namesFromManifest(".env.example", "# only a comment\n\n  \n")).toEqual([]);
  });

  it("ignores lines without =", () => {
    expect(namesFromManifest(".env.example", "OPENAI_API_KEY\nFOO=bar")).toEqual(["FOO"]);
  });
});

describe("namesFromManifest — unknown path", () => {
  it("returns [] for paths we don't know how to parse", () => {
    expect(namesFromManifest("Cargo.toml", '[dependencies]\nopenai = "1.0"')).toEqual([]);
  });
});

describe("detectRepoStack — end-to-end against mocked GitHub Contents API", () => {
  it("matches founder-vocab strings as substrings against package.json deps", async () => {
    mockFetchByUrl({
      "/contents/package.json": {
        body: JSON.stringify({
          dependencies: { "@anthropic-ai/sdk": "^0.30", openai: "^1.0", twilio: "^9.0" },
          devDependencies: { vitest: "^1.0" },
        }),
      },
    });
    const out = await detectRepoStack({
      owner: "ada",
      repo: "agent",
      vocab: ["anthropic", "openai", "twilio", "sendgrid"],
    });
    // sendgrid in vocab but absent → not detected.
    // The other three substring-match against the dep keys.
    expect(out.detected).toEqual(["anthropic", "openai", "twilio"]);
    expect(out.manifestsFound).toEqual(["package.json"]);
  });

  it("aggregates across multiple manifests (npm + python + env-keys)", async () => {
    mockFetchByUrl({
      "/contents/package.json": {
        body: JSON.stringify({ dependencies: { twilio: "^9.0" } }),
      },
      "/contents/requirements.txt": {
        body: "openai==1.0\nanthropic==0.30\n",
      },
      "/contents/.env.example": {
        body: "SENDGRID_API_KEY=\nTWILIO_ACCOUNT_SID=\n",
      },
    });
    const out = await detectRepoStack({
      owner: "ada",
      repo: "agent",
      vocab: ["twilio", "openai", "anthropic", "sendgrid"],
    });
    // `sendgrid` matches via `SENDGRID_API_KEY` (env keys lowercased before match).
    expect(out.detected.toSorted()).toEqual(["anthropic", "openai", "sendgrid", "twilio"]);
    expect(out.manifestsFound.toSorted()).toEqual([
      ".env.example",
      "package.json",
      "requirements.txt",
    ]);
  });

  it("substring-matches across package-name shapes from a single vocab token", async () => {
    mockFetchByUrl({
      "/contents/package.json": {
        body: JSON.stringify({
          dependencies: { "twilio-node": "^4.0", "@twilio/voice-sdk": "^2.0" },
        }),
      },
      "/contents/.env.example": { body: "TWILIO_ACCOUNT_SID=\nTWILIO_AUTH_TOKEN=\n" },
    });
    const out = await detectRepoStack({
      owner: "ada",
      repo: "agent",
      vocab: ["twilio"],
    });
    // Single vocab token catches all three shapes (scoped, hyphenated, env-key).
    expect(out.detected).toEqual(["twilio"]);
  });

  it("is case-insensitive on both sides (founder may type any casing)", async () => {
    mockFetchByUrl({
      "/contents/package.json": {
        body: JSON.stringify({ dependencies: { "twilio-node": "^4.0" } }),
      },
    });
    const cap = await detectRepoStack({ owner: "ada", repo: "agent", vocab: ["Twilio"] });
    const low = await detectRepoStack({ owner: "ada", repo: "agent", vocab: ["twilio"] });
    expect(cap.detected).toEqual(["Twilio"]);
    expect(low.detected).toEqual(["twilio"]);
  });

  it("returns empty detection for empty vocab", async () => {
    mockFetchByUrl({
      "/contents/package.json": {
        body: JSON.stringify({ dependencies: { twilio: "^9.0", openai: "^1.0" } }),
      },
    });
    const out = await detectRepoStack({ owner: "ada", repo: "agent", vocab: [] });
    expect(out.detected).toEqual([]);
    expect(out.manifestsFound).toEqual(["package.json"]);
  });

  it("ignores blank vocab strings (defensive)", async () => {
    mockFetchByUrl({
      "/contents/package.json": {
        body: JSON.stringify({ dependencies: { twilio: "^9.0" } }),
      },
    });
    const out = await detectRepoStack({
      owner: "ada",
      repo: "agent",
      vocab: ["", "  ", "twilio"],
    });
    expect(out.detected).toEqual(["twilio"]);
  });

  it("returns no detections when nothing in vocab matches", async () => {
    mockFetchByUrl({
      "/contents/package.json": {
        body: JSON.stringify({ dependencies: { lodash: "^4.0", express: "^4.0" } }),
      },
    });
    const out = await detectRepoStack({
      owner: "ada",
      repo: "agent",
      vocab: ["twilio", "openai"],
    });
    expect(out.detected).toEqual([]);
    expect(out.manifestsFound).toEqual(["package.json"]);
  });

  it("returns empty when ALL manifest fetches fail (404 on every path)", async () => {
    mockFetchByUrl({});
    const out = await detectRepoStack({ owner: "ada", repo: "agent", vocab: ["twilio"] });
    expect(out.detected).toEqual([]);
    expect(out.manifestsFound).toEqual([]);
  });

  it("URL-encodes owner/repo (defense against weird names)", async () => {
    let captured = "";
    globalThis.fetch = (async (input: unknown) => {
      captured = typeof input === "string" ? input : (input as { url: string }).url;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await detectRepoStack({ owner: "weird name", repo: "weird repo", vocab: [] });
    expect(captured).toContain("weird%20name");
    expect(captured).toContain("weird%20repo");
  });
});
