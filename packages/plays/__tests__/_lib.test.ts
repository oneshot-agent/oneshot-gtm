import { describe, expect, it } from "vitest";
import { lintEmail } from "../src/_lib.ts";

describe("lintEmail — humanizer canon", () => {
  it("returns no flags for a clean founder-to-founder email", () => {
    const subject = "saw your show hn";
    const body = [
      "Saw your post about durable workflows yesterday.",
      "Did the Postgres backend hold up to the 1k concurrent jobs you described?",
      "Sam",
    ].join("\n\n");
    expect(lintEmail(subject, body)).toEqual([]);
  });

  it("flags em dashes", () => {
    const flags = lintEmail("re: your post", "Saw your post — quick thought. Sam");
    expect(flags).toContain("em-dash");
  });

  it("flags banned openers", () => {
    expect(lintEmail("hi", "I noticed your work and wanted to reach out. Sam")).toContain(
      "banned-opener:I-noticed",
    );
    expect(lintEmail("hi", "I came across your post yesterday. Sam")).toContain(
      "banned-opener:I-came-across",
    );
    expect(lintEmail("hi", "Hope this email finds you well. Sam")).toContain(
      "banned-opener:hope-this-finds",
    );
  });

  it("flags AI vocabulary", () => {
    expect(lintEmail("hi", "We help you leverage your data effectively. Sam")).toContain(
      "ai-vocab",
    );
    expect(lintEmail("hi", "Our pivotal moment is now. Sam")).toContain("ai-vocab");
  });

  it("flags copula avoidance", () => {
    expect(lintEmail("hi", "Our product serves as the bridge to scale. Sam")).toContain(
      "copula-avoidance",
    );
  });

  it("flags rule-of-three lists", () => {
    expect(lintEmail("hi", "We deliver speed, quality, and adoption to your team. Sam")).toContain(
      "rule-of-three",
    );
  });

  it("flags negative parallelism", () => {
    expect(
      lintEmail("hi", "It's not just a tool, it's a movement that changes everything. Sam"),
    ).toContain("negative-parallelism");
  });

  it("flags servile closers", () => {
    expect(lintEmail("hi", "Hope this helps. Let me know if you want more. Sam")).toContain(
      "servile-closer",
    );
  });

  it("flags shouty subjects and excess exclamations", () => {
    expect(lintEmail("RE THE POST", "Body. Sam")).toContain("subject-shouty");
    expect(lintEmail("hi", "First!! Second!! Sam")).toContain("excess-exclamations");
  });

  it("flags calendar links", () => {
    expect(lintEmail("hi", "Here's my calendly link to book. Sam")).toContain("calendar-link");
  });

  it("flags emojis and curly quotes", () => {
    expect(lintEmail("hi", "Awesome work 🚀. Sam")).toContain("emoji");
    expect(lintEmail("hi", "He said “hi” to me. Sam")).toContain("curly-quotes");
  });

  it("flags empty subject and body", () => {
    expect(lintEmail("", "Body. Sam")).toContain("empty-subject");
    expect(lintEmail("hi", "")).toContain("empty-body");
  });

  it("flags subject longer than 60 chars", () => {
    const longSubj = "x".repeat(80);
    expect(lintEmail(longSubj, "Body. Sam")).toContain("subject-too-long");
  });

  it("flags body over the maxBodyWords cap", () => {
    const body = Array.from({ length: 150 }, () => "word").join(" ");
    expect(lintEmail("hi", body, 100)).toContain("body-too-long");
  });
});
