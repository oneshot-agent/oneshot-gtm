import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadVoiceCorpus, voiceCorpusPrompt } from "../src/commands/_voice-corpus.ts";

// The founder's writing, read from local files for `config voice`: posted
// work ranks first, frontmatter and editorial trailers are stripped, fenced
// blocks under a Daily/ folder are the approved messages, duplicates and
// caps hold, and the guide rides along as evidence.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oneshot-voice-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function post(name: string, status: string | null, body: string, style = "taleb-aphoristic") {
  const fm = status ? `---\ntitle: "${name}"\nstatus: ${status}\nstyle: ${style}\n---\n` : "";
  writeFileSync(
    join(dir, name),
    `${fm}# ${name}\n\n${body}\n\n## METADATA\n\n**Style Applied:** stuff\n`,
  );
}

const BODY = (n: number) =>
  `free tools make reckless agents number ${n}. when every call costs nothing, nobody learns restraint. cost is information.`;

describe("loadVoiceCorpus", () => {
  it("ranks posted work first, strips frontmatter, headings and trailers, and skips stubs", () => {
    post("draft.md", "draft", BODY(1));
    post("posted.md", "posted", BODY(2));
    post("published.md", "published", BODY(3));
    post("untagged.md", null, BODY(4));
    post("stub.md", "posted", "too short");
    const { items, files } = loadVoiceCorpus([dir]);
    expect(files).toBe(5);
    expect(items.map((i) => i.path.split("/").pop())).toEqual([
      "posted.md",
      "published.md",
      "draft.md",
      "untagged.md",
    ]);
    expect(items[0]!.text).not.toContain("---");
    expect(items[0]!.text).not.toContain("METADATA");
    expect(items[0]!.text).not.toContain("# posted.md");
    expect(items[0]!.text).toContain("cost is information.");
  });

  it("reads --messages files as sent messages: each fenced block, or the whole body, ranked first", () => {
    mkdirSync(join(dir, "sent"));
    writeFileSync(
      join(dir, "sent", "outreach.md"),
      "## Person\n\n```\nwe shipped an MIT GTM agent that prints signed receipts for every call. does this match how you measure spend?\n```\n\n```\nshort\n```\n",
    );
    writeFileSync(
      join(dir, "sent", "plain.txt"),
      "saw your repo pinning model routing down to the provider. did the fallback ever fire in prod?",
    );
    post("posted.md", "posted", BODY(1));
    const { items } = loadVoiceCorpus([join(dir, "posted.md")], { messages: [join(dir, "sent")] });
    expect(items.map((i) => i.kind)).toEqual(["dm", "dm", "post"]);
    expect(items.some((i) => i.text === "short")).toBe(false);
  });

  it("dedupes repeated text and honours the item and character caps", () => {
    for (let i = 0; i < 6; i++) post(`p${i}.md`, "posted", BODY(i));
    post("dup.md", "posted", BODY(1));
    const capped = loadVoiceCorpus([dir], { maxItems: 3 });
    expect(capped.items).toHaveLength(3);
    const byChars = loadVoiceCorpus([dir], { maxChars: 250 });
    expect(byChars.items.length).toBeLessThan(4);
    expect(byChars.items.every((i) => i.text.length <= 250)).toBe(true);
    const all = loadVoiceCorpus([dir]);
    expect(all.items).toHaveLength(6);
  });

  it("carries the guide whole and numbers posts and messages in the prompt", () => {
    post("posted.md", "posted", BODY(1));
    writeFileSync(
      join(dir, "guide.md"),
      "---\ntitle: g\n---\n# Guide\n\nlowercase by default. vary length.\n",
    );
    const corpus = loadVoiceCorpus([join(dir, "posted.md")], { guide: join(dir, "guide.md") });
    expect(corpus.guide).toContain("lowercase by default");
    const prompt = voiceCorpusPrompt(corpus);
    expect(prompt).toMatch(/^GUIDE:\n/);
    expect(prompt).toContain("POSTS (1):\n1. free tools");
    expect(prompt).toContain("DMS (0):\n(none)");
  });

  it("caps messages so posts still reach the prompt", () => {
    mkdirSync(join(dir, "sent"));
    for (let i = 0; i < 20; i++)
      writeFileSync(join(dir, "sent", `m${i}.txt`), `${BODY(i)} sent message ${i}`);
    for (let i = 0; i < 5; i++) post(`p${i}.md`, "posted", BODY(100 + i));
    const { items } = loadVoiceCorpus([dir], {
      messages: [join(dir, "sent")],
      maxItems: 20,
      maxMessages: 8,
    });
    expect(items.filter((i) => i.kind === "dm")).toHaveLength(8);
    expect(items.filter((i) => i.kind === "post").length).toBeGreaterThanOrEqual(5);
  });

  it("is empty, not thrown, on a missing path", () => {
    expect(loadVoiceCorpus([join(dir, "nope")]).items).toEqual([]);
  });
});
