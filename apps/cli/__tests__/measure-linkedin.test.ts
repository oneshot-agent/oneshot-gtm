import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";
import { getLedger } from "@oneshot-gtm/core";
import { commandLinkedInInvites, commandMeasure } from "../src/commands/measure-linkedin.ts";
import { setJsonMode } from "../src/output.ts";

// `measure --json` and `linkedin invites` over a real ledger in the isolated
// ONESHOT_GTM_HOME the test setup creates (never real config).

let out: string;
const DAY = 86_400_000;
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString();
const sqlite = (s: string): string => s.slice(0, 19).replace("T", " ");

function stamp(id: number, when: string): void {
  const db = new Database(`${process.env["ONESHOT_GTM_HOME"]}/ledger.sqlite`);
  db.query("UPDATE sequence_events SET created_at = ? WHERE id = ?").run(sqlite(when), id);
  db.close();
}

function invite(name: string, daysAgo: number, meta: Record<string, unknown> = {}): number {
  const ledger = getLedger();
  const prospectId = ledger.upsertProspect({
    name,
    email: `${name.toLowerCase()}@example.test`,
    linkedin_url: `https://linkedin.com/in/${name.toLowerCase()}`,
  });
  const id = ledger.recordLinkedInInviteEvent({
    prospectId,
    playName: "luma-events",
    stepIndex: 0,
    status: "sent",
    metadata: { invitationId: `inv-${name}`, ...meta },
  });
  stamp(id, iso(daysAgo));
  return prospectId;
}

beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((
    s: string | Uint8Array,
    encodingOrCallback?: unknown,
    callback?: unknown,
  ) => {
    out += String(s);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof done === "function") done();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    out += String(s);
    return true;
  });
  getLedger(); // creates the schema in the isolated home
  const db = new Database(`${process.env["ONESHOT_GTM_HOME"]}/ledger.sqlite`);
  db.exec("DELETE FROM sequence_events; DELETE FROM channel_events;");
  db.close();
  invite("Pia", 5, { evidenceClause: true });
  invite("Quin", 20, { evidenceClause: false, acceptedAt: iso(18) });
  const rene = invite("Rene", 30);
  const ledger = getLedger();
  const w = ledger.recordLinkedInInviteEvent({
    prospectId: rene,
    playName: "luma-events",
    stepIndex: 0,
    status: "withdrawn",
    metadata: { withdrawnBy: "timeout" },
  });
  stamp(w, iso(9));
});

afterEach(() => {
  vi.restoreAllMocks();
  setJsonMode(false);
});

const json = (): Record<string, any> => JSON.parse(out.trim().split("\n").at(-1)!);

describe("measure --json", () => {
  it("includes a linkedin block with the funnel and the variant split", async () => {
    await commandMeasure({ json: true });
    const body = json();
    expect(body["command"]).toBe("measure");
    expect(body["events"]).toEqual([
      { playName: "luma-events", sent: 3, delivered: 0, replied: 0, bounced: 0 },
    ]);
    const li = body["linkedin"];
    expect(li.funnel.invitesSent).toBe(3);
    expect(li.funnel.pending).toBe(1);
    expect(li.funnel.withdrawn).toMatchObject({ total: 1, timeout: 1 });
    expect(li.funnel.accepted).toMatchObject({ total: 1, viaInvitation: 1, medianDaysToAccept: 2 });
    expect(li.variants.withEvidence.invitesSent).toBe(1);
    expect(li.variants.withoutEvidence.invitesSent).toBe(1);
    expect(li.variants.unrecorded.invitesSent).toBe(1);
    expect(li.plays).toEqual(["luma-events"]);
  });

  it("applies the play, step-kind and since-days filters", async () => {
    await commandMeasure({ json: true, stepKind: "continuation" });
    expect(json()["linkedin"].funnel.invitesSent).toBe(0);
    out = "";
    await commandMeasure({ json: true, sinceDays: 10 });
    expect(json()["linkedin"].funnel.invitesSent).toBe(1);
    out = "";
    await commandMeasure({ json: true, play: "no-such-play" });
    expect(json()["linkedin"].funnel.invitesSent).toBe(0);
  });

  it("rejects a step kind it does not know", async () => {
    await expect(commandMeasure({ json: true, stepKind: "cold" })).rejects.toThrow(/step-kind/);
  });

  it("prints the funnel for a person", async () => {
    await commandMeasure({});
    expect(out).toContain("replied to the first message");
    expect(out).toContain("note with an evidence clause");
  });

  it("prints the funnel when the view holds only known connections, and says so when it holds nothing", async () => {
    const db = new Database(`${process.env["ONESHOT_GTM_HOME"]}/ledger.sqlite`);
    db.exec("DELETE FROM sequence_events;");
    db.close();
    await commandMeasure({});
    expect(out).toContain("No LinkedIn invites sent in this view.");
    out = "";
    invite("Sol", 2, {
      invitationId: undefined,
      inviteStatus: "already_connected",
      via: "profile-read",
    });
    await commandMeasure({});
    expect(out).not.toContain("No LinkedIn invites sent in this view.");
    expect(out).toMatch(/invites sent\s+0/);
    expect(out).toMatch(/already connected\s+1/);
  });
});

describe("linkedin invites", () => {
  const rows = (): Array<Record<string, any>> => json()["invites"];

  it("lists one row per invite with the fields to compare against LinkedIn", async () => {
    await commandLinkedInInvites({ json: true });
    const all = rows();
    expect(all).toHaveLength(3);
    const pia = all.find((r) => r["prospect"] === "Pia")!;
    expect(pia).toMatchObject({
      profile: "https://linkedin.com/in/pia",
      state: "pending",
      daysPending: 5,
      conversationId: null,
      stepIndex: 0,
      stepKind: "first-touch",
    });
    expect(typeof pia["sentAt"]).toBe("string");
  });

  it.each([
    ["pending", ["Pia"]],
    ["accepted", ["Quin"]],
    ["withdrawn", ["Rene"]],
  ])("filters by --status %s", async (status, names) => {
    await commandLinkedInInvites({ json: true, status });
    expect(rows().map((r) => r["prospect"])).toEqual(names);
  });

  it("filters by --since", async () => {
    await commandLinkedInInvites({ json: true, since: iso(10).slice(0, 10) });
    expect(rows().map((r) => r["prospect"])).toEqual(["Pia"]);
  });

  it("rejects a status or a date it does not know", async () => {
    await expect(commandLinkedInInvites({ status: "declined" })).rejects.toThrow(/--status/);
    await expect(commandLinkedInInvites({ since: "last week" })).rejects.toThrow(/--since/);
  });

  it("prints a table for a person, and says when nothing matches", async () => {
    await commandLinkedInInvites({});
    expect(out).toContain("Pia");
    expect(out).toContain("accepted (invitation)");
    expect(out).toContain("withdrawn (timeout)");
    out = "";
    await commandLinkedInInvites({ since: "2999-01-01" });
    expect(out).toContain("No invites match.");
  });
});
