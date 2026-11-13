import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";
import { angleTextKey, type AngleOutcomeRow } from "../src/ledger-drafts.ts";
import {
  fisherOneSidedGreater,
  outcomeAngleText,
  qualifyingAngles,
} from "../src/learning-outcome.ts";
import { learningScopeKey } from "../src/learning-store.ts";

// Reply-based content learning: which configured angle out-replies its play's
// others, by distinct people, per channel and drafting stage.

describe("fisherOneSidedGreater", () => {
  it("matches the hypergeometric tail", () => {
    // 3 of 3 against 0 of 3: one table of C(6,3) = 20 is at least this lopsided.
    expect(fisherOneSidedGreater(3, 3, 0, 3)).toBeCloseTo(1 / 20, 10);
    // 2 of 3 against 1 of 3: (9 + 1) / 20.
    expect(fisherOneSidedGreater(2, 3, 1, 3)).toBeCloseTo(10 / 20, 10);
    // Every table is at least zero.
    expect(fisherOneSidedGreater(0, 40, 5, 60)).toBeCloseTo(1, 10);
    expect(fisherOneSidedGreater(7, 61, 4, 212)).toBeLessThan(0.01);
    expect(fisherOneSidedGreater(3, 30, 1, 20)).toBeGreaterThan(0.1);
  });

  it("is 1 when either group is empty", () => {
    expect(fisherOneSidedGreater(5, 30, 0, 0)).toBe(1);
    expect(fisherOneSidedGreater(0, 0, 5, 30)).toBe(1);
  });
});

const row = (over: Partial<AngleOutcomeRow>): AngleOutcomeRow => ({
  playName: "p",
  channel: "email",
  stage: "first_touch",
  angleKey: "a",
  angleText: "Angle A",
  configured: true,
  reached: 61,
  replied: 7,
  otherReached: 212,
  otherReplied: 4,
  repliedVersionIds: [],
  ...over,
});

describe("qualifyingAngles", () => {
  it("keeps an angle that clears every threshold, best first", () => {
    const strong = row({ angleKey: "strong", replied: 12 });
    const out = qualifyingAngles([row({}), strong]);
    expect(out.map((r) => r.angleKey)).toEqual(["strong", "a"]);
  });

  it("drops each threshold failure", () => {
    expect(qualifyingAngles([row({ reached: 29 })])).toEqual([]);
    expect(qualifyingAngles([row({ replied: 2, otherReplied: 0 })])).toEqual([]);
    // 11% against 6%: under double.
    expect(qualifyingAngles([row({ otherReplied: 13 })])).toEqual([]);
    // 15% against 8%: significant, but under double.
    const big = row({ reached: 200, replied: 30, otherReached: 1000, otherReplied: 80 });
    expect(fisherOneSidedGreater(30, 200, 80, 1000)).toBeLessThan(0.01);
    expect(qualifyingAngles([big])).toEqual([]);
    expect(
      qualifyingAngles([row({ reached: 30, replied: 3, otherReached: 20, otherReplied: 1 })]),
    ).toEqual([]);
    expect(qualifyingAngles([row({ configured: false })])).toEqual([]);
    expect(qualifyingAngles([row({ otherReached: 0, otherReplied: 0 })])).toEqual([]);
  });

  it("takes exactly double as double", () => {
    // 10 of 50 against 10 of 100.
    expect(
      qualifyingAngles([row({ reached: 50, replied: 10, otherReached: 100, otherReplied: 10 })]),
    ).toHaveLength(1);
    expect(
      qualifyingAngles([row({ reached: 50, replied: 10, otherReached: 100, otherReplied: 11 })]),
    ).toEqual([]);
  });
});

describe("outcomeAngleText", () => {
  it("flattens, drops trailing punctuation, and cuts long text at a word", () => {
    expect(outcomeAngleText("  For a CTO —\n the stack breaks. ")).toBe(
      "For a CTO — the stack breaks",
    );
    const long = outcomeAngleText(`${"word ".repeat(100)}end`, 40);
    expect(long.length).toBeLessThanOrEqual(41);
    expect(long.endsWith("word…")).toBe(true);
  });
});

it("a reply-based preference has its own area beside the style one", () => {
  expect(learningScopeKey("preference", { channel: "email", stage: "first_touch" })).toBe(
    "pref:email:first_touch",
  );
  expect(
    learningScopeKey("preference", { channel: "email", stage: "first_touch", basis: "replies" }),
  ).toBe("pref:email:first_touch:replies");
});

describe("angleOutcomesByStage", () => {
  let dbPath: string;
  let ledger: Ledger;
  let raw: Database;
  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `oneshot-gtm-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    ledger = new Ledger(dbPath);
    raw = new Database(dbPath);
  });
  afterEach(() => {
    raw.close();
    ledger.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  });

  function send(input: {
    email: string;
    angle: string;
    step?: number;
    replied?: boolean;
    writer?: "template" | "model";
    origin?: "configured" | "generated";
  }): void {
    const step = input.step ?? 0;
    raw
      .query("INSERT OR IGNORE INTO prospects(name, email, source) VALUES('P', ?, 't')")
      .run(input.email);
    const { id } = raw.query("SELECT id FROM prospects WHERE email=?").get(input.email) as {
      id: number;
    };
    raw
      .query(
        `INSERT INTO draft_versions(play_name, prospect_key, step_index, prospect_id, subject, body,
           angle_key, angle_text, angle_origin, outcome, channel, writer, closed_at)
         VALUES ('play',?,?,?,'s','b',?,?,?,'sent','email',?,datetime('now'))`,
      )
      .run(
        input.email,
        step,
        id,
        angleTextKey(input.angle),
        input.angle,
        input.origin ?? "configured",
        input.writer ?? null,
      );
    if (input.replied)
      raw
        .query(
          "INSERT INTO sequence_events(prospect_id, play_name, step_index, channel, status) VALUES (?, 'play', ?, 'email', 'replied')",
        )
        .run(id, step);
  }

  it("counts distinct people per stage, keeps the groups disjoint, and skips template sends", () => {
    send({ email: "a1@x.dev", angle: "A", replied: true });
    send({ email: "a2@x.dev", angle: "A" });
    send({ email: "b1@x.dev", angle: "B", replied: true });
    send({ email: "b2@x.dev", angle: "B" });
    // A template's text does not argue the angle.
    send({ email: "t1@x.dev", angle: "A", replied: true, writer: "template" });
    // Follow-ups are their own stage: a1 got B there, and is counted only under A for intros.
    send({ email: "a1@x.dev", angle: "B", step: 1 });
    send({ email: "a2@x.dev", angle: "A", step: 1, origin: "generated" });

    const rows = ledger.angleOutcomesByStage();
    const get = (stage: string, text: string) =>
      rows.find((r) => r.stage === stage && r.angleText === text)!;
    expect(get("first_touch", "A")).toMatchObject({
      reached: 2,
      replied: 1,
      otherReached: 2,
      otherReplied: 1,
      configured: true,
    });
    expect(get("first_touch", "A").repliedVersionIds).toHaveLength(1);
    expect(get("first_touch", "B")).toMatchObject({ reached: 2, replied: 1, otherReached: 2 });
    expect(get("follow_up", "A")).toMatchObject({ reached: 1, otherReached: 1, configured: false });
    expect(rows.filter((r) => r.stage === "follow_up")).toHaveLength(2);
  });

  it("never counts a person on both sides", () => {
    // p got A and later B in the same follow-up stage (two steps).
    send({ email: "p@x.dev", angle: "A", step: 1, replied: true });
    send({ email: "p@x.dev", angle: "B", step: 2 });
    send({ email: "q@x.dev", angle: "B", step: 1 });
    const rows = ledger.angleOutcomesByStage();
    const a = rows.find((r) => r.angleText === "A")!;
    const b = rows.find((r) => r.angleText === "B")!;
    expect(a).toMatchObject({ reached: 1, replied: 1, otherReached: 1, otherReplied: 0 });
    expect(b).toMatchObject({ reached: 2, replied: 0, otherReached: 0, otherReplied: 0 });
  });
});
