import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";
import { canInviteOnLinkedIn, type LinkedInGuardLedger } from "../src/linkedin-guard.ts";
import { getSharedDb, liveCadenceElsewhere, SharedDb } from "../src/shared-db.ts";
import { SharedPeople } from "../src/shared-people.ts";

// Every shared file here is under a temp dir: the per-test `dir`, or the one
// vitest.setup.ts points ONESHOT_GTM_SHARED at for getSharedDb().

let dir: string;
let sharedPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oneshot-presence-"));
  sharedPath = join(dir, "shared.sqlite");
  process.env["ONESHOT_GTM_WORKSPACE"] = "alpha";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["ONESHOT_GTM_WORKSPACE"];
  delete process.env["ONESHOT_GTM_DEMO"];
});

function ledgerFor(name = "ledger.sqlite"): Ledger {
  return new Ledger(join(dir, name), { sharedPeoplePath: sharedPath });
}

function presence(db: SharedDb, workspace = "alpha") {
  return db.cadencePresenceOf(workspace).map((r) => [r.play_name, r.email, r.status]);
}

const DUE = "2026-11-08T09:00:00.000Z";

/** One cadence in workspace `workspace`, as that workspace's ledger mirrors it. */
function seed(
  db: SharedDb,
  workspace: string,
  row: {
    email?: string | null;
    linkedinUrl?: string | null;
    status: string;
    play?: string;
    prospectId?: number;
  },
): void {
  const prospectId = row.prospectId ?? 1;
  db.syncCadencePresence(
    workspace,
    [
      {
        prospectId,
        playName: row.play ?? "other-play",
        email: row.email ?? null,
        linkedinUrl: row.linkedinUrl ?? null,
        status: row.status,
      },
    ],
    { prospectIds: [prospectId] },
  );
}

describe("cadence presence from the ledger", () => {
  it("mirrors an enrolment and every status change", () => {
    const ledger = ledgerFor();
    const shared = new SharedDb(sharedPath);
    const id = ledger.upsertProspect({
      email: "Jane@Acme.dev",
      name: "Jane Doe",
      linkedin_url: "https://www.linkedin.com/in/Jane-Doe/",
      source: "test",
    });
    ledger.enrollCadence({ prospectId: id, playName: "intro", nextDueAt: DUE });
    expect(shared.cadencePresenceOf("alpha")).toEqual([
      expect.objectContaining({
        workspace: "alpha",
        play_name: "intro",
        prospect_id: id,
        email: "jane@acme.dev",
        linkedin_slug: "jane-doe",
        status: "active",
      }),
    ]);

    ledger.setCadenceStatus({ prospectId: id, playName: "intro", status: "completed" });
    expect(presence(shared)).toEqual([["intro", "jane@acme.dev", "completed"]]);

    ledger.enrollCadence({ prospectId: id, playName: "second", nextDueAt: DUE });
    expect(ledger.stopCadence({ prospectId: id, playName: "second", reason: "other" })).toBe(true);
    expect(presence(shared)).toEqual([
      ["intro", "jane@acme.dev", "completed"],
      ["second", "jane@acme.dev", "stopped"],
    ]);

    ledger.enrollCadence({ prospectId: id, playName: "third", nextDueAt: DUE });
    ledger.suppressCadencesForReply(id);
    expect(presence(shared)).toContainEqual(["third", "jane@acme.dev", "replied"]);
    ledger.close();
    shared.close();
  });

  it("backfills idempotently and drops this workspace's rows for cadences that are gone", () => {
    const ledger = ledgerFor();
    const shared = new SharedDb(sharedPath);
    const a = ledger.upsertProspect({ email: "a@acme.dev", source: "test" });
    const b = ledger.upsertProspect({ email: "b@acme.dev", source: "test" });
    ledger.enrollCadence({ prospectId: a, playName: "intro", nextDueAt: DUE });
    ledger.enrollCadence({ prospectId: b, playName: "intro", nextDueAt: DUE });
    // A row written before the cadence went away (another ledger file of the
    // same workspace, a deleted prospect): the backfill removes it.
    seed(shared, "alpha", {
      email: "gone@acme.dev",
      status: "active",
      play: "old",
      prospectId: 999,
    });
    seed(shared, "beta", { email: "a@acme.dev", status: "active" });

    expect(ledger.backfillCadencePresence()).toEqual({ changed: 0, removed: 1 });
    expect(presence(shared)).toEqual([
      ["intro", "a@acme.dev", "active"],
      ["intro", "b@acme.dev", "active"],
    ]);
    const before = shared.cadencePresenceOf("alpha");
    expect(ledger.backfillCadencePresence()).toEqual({ changed: 0, removed: 0 });
    expect(shared.cadencePresenceOf("alpha")).toEqual(before);
    // Another workspace's rows are never touched.
    expect(presence(shared, "beta")).toEqual([["other-play", "a@acme.dev", "active"]]);
    ledger.close();
    shared.close();
  });

  it("writes nothing for a fixture database or in demo mode", () => {
    const fixture = new Ledger(join(dir, "fixture.sqlite"));
    const id = fixture.upsertProspect({ email: "f@acme.dev", source: "test" });
    fixture.enrollCadence({ prospectId: id, playName: "intro", nextDueAt: DUE });
    expect(fixture.backfillCadencePresence()).toBeNull();
    fixture.close();

    process.env["ONESHOT_GTM_DEMO"] = "1";
    const demo = ledgerFor("demo.sqlite");
    const did = demo.upsertProspect({ email: "d@acme.dev", source: "test" });
    demo.enrollCadence({ prospectId: did, playName: "intro", nextDueAt: DUE });
    expect(demo.backfillCadencePresence()).toBeNull();
    demo.close();
    const shared = new SharedDb(sharedPath);
    expect(shared.cadencePresenceOf("alpha")).toEqual([]);
    shared.close();
    expect(getSharedDb().cadencePresenceOf("alpha")).toEqual([]);
  });
});

describe("liveCadenceElsewhere", () => {
  it("holds for another workspace's active or paused cadence, never an ended one or its own", () => {
    const db = new SharedDb(sharedPath);
    seed(db, "beta", { email: "jane@acme.dev", status: "active" });
    expect(db.liveCadenceElsewhere({ email: "JANE@acme.dev", workspace: "alpha" })).toMatchObject({
      workspace: "beta",
      play_name: "other-play",
      status: "active",
    });
    seed(db, "beta", { email: "jane@acme.dev", status: "paused" });
    expect(db.liveCadenceElsewhere({ email: "jane@acme.dev", workspace: "alpha" })?.status).toBe(
      "paused",
    );
    for (const ended of ["replied", "completed", "breakup", "stopped", "bounced"]) {
      seed(db, "beta", { email: "jane@acme.dev", status: ended });
      expect(db.liveCadenceElsewhere({ email: "jane@acme.dev", workspace: "alpha" })).toBeNull();
    }
    seed(db, "alpha", { email: "own@acme.dev", status: "active" });
    expect(db.liveCadenceElsewhere({ email: "own@acme.dev", workspace: "alpha" })).toBeNull();
    db.close();
  });

  it("matches a known email alias and the LinkedIn profile", () => {
    const db = new SharedDb(sharedPath);
    const people = new SharedPeople(sharedPath);
    const person = people.resolve({ email: "jane@old.dev" });
    people.resolve({ email: "jane@new.example" }, person.id);
    seed(db, "beta", { email: "jane@old.dev", status: "active" });
    expect(
      db.liveCadenceElsewhere({ email: "jane@new.example", workspace: "alpha" })?.workspace,
    ).toBe("beta");

    seed(db, "gamma", {
      email: null,
      linkedinUrl: "https://uk.linkedin.com/in/Sam-Roe",
      status: "active",
    });
    expect(
      db.liveCadenceElsewhere({
        email: "sam@elsewhere.dev",
        linkedinUrl: "https://www.linkedin.com/in/sam-roe/",
        workspace: "alpha",
      })?.workspace,
    ).toBe("gamma");
    // An X or GitHub URL is not a LinkedIn profile.
    expect(
      db.liveCadenceElsewhere({ linkedinUrl: "https://x.com/sam-roe", workspace: "alpha" }),
    ).toBeNull();
    people.close();
    db.close();
  });

  it("reads the process-wide shared DB, and nothing in demo mode", () => {
    seed(getSharedDb(), "beta", { email: "demo@acme.dev", status: "active" });
    expect(liveCadenceElsewhere({ email: "demo@acme.dev" })?.workspace).toBe("beta");
    process.env["ONESHOT_GTM_DEMO"] = "1";
    expect(liveCadenceElsewhere({ email: "demo@acme.dev" })).toBeNull();
  });

  it("lists this workspace's live cadences that another workspace also runs", () => {
    const db = new SharedDb(sharedPath);
    seed(db, "alpha", { email: "jane@acme.dev", status: "active", play: "intro" });
    seed(db, "beta", { email: "jane@acme.dev", status: "paused", play: "their-play" });
    seed(db, "gamma", { email: "jane@acme.dev", status: "completed", play: "ended" });
    expect(
      db.cadenceOverlaps("alpha").map((o) => [o.here.play_name, o.elsewhere.workspace]),
    ).toEqual([["intro", "beta"]]);
    expect(db.cadenceOverlaps("gamma")).toEqual([]);
    db.close();
  });
});

describe("the LinkedIn invite guard", () => {
  const ledger: LinkedInGuardLedger = {
    resolveProspectForLinkedInReply: () => ({ status: "unmatched" }),
    linkedInGuardFacts: () => null,
  };
  const inbox = { hasConversationWith: () => false };
  const prospect = {
    name: "Sam Roe",
    company: "Acme",
    email: "sam@acme.dev",
    linkedinUrl: "https://www.linkedin.com/in/sam-roe",
  };

  it("refuses a first-touch invite while another workspace's sequence is live, not a cadence step", () => {
    const shared = new SharedDb(sharedPath);
    seed(shared, "beta", { linkedinUrl: prospect.linkedinUrl, status: "active", play: "intro" });
    expect(
      canInviteOnLinkedIn({ ...prospect, firstTouch: true }, { ledger, inbox, shared }),
    ).toEqual({
      ok: false,
      reason: "live-elsewhere",
      detail: "in a live sequence in workspace 'beta' (intro)",
    });
    expect(canInviteOnLinkedIn(prospect, { ledger, inbox, shared })).toEqual({ ok: true });
    seed(shared, "beta", { linkedinUrl: prospect.linkedinUrl, status: "replied", play: "intro" });
    expect(
      canInviteOnLinkedIn({ ...prospect, firstTouch: true }, { ledger, inbox, shared }),
    ).toEqual({ ok: true });
    shared.close();
  });
});
