import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SharedDb } from "../src/shared-db.ts";
import { Ledger } from "../src/ledger.ts";
import { SharedPeople } from "../src/shared-people.ts";

let root: string;
let beta: Ledger;
let alpha: Ledger;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shared-people-"));
  const options = { sharedPeoplePath: join(root, "shared.sqlite") };
  beta = new Ledger(join(root, "beta.sqlite"), options);
  alpha = new Ledger(join(root, "alpha.sqlite"), options);
});
afterEach(() => {
  beta.close();
  alpha.close();
  rmSync(root, { recursive: true, force: true });
});

describe("shared person identity with workspace memberships", () => {
  it("listProspectsByIds (#935) overlays every row's shared person from one bulk read, same values as getProspectById", () => {
    const ids = Array.from({ length: 5 }, (_, i) =>
      beta.upsertProspect({ name: `Person ${i}`, email: `bulk-${i}@example.test` }),
    );
    // The registry learns a title beta's row never had: only the overlay shows it.
    const person = new SharedPeople(join(root, "shared.sqlite"));
    person.setRole(beta.getProspectById(ids[2]!)!.shared_person_id!, { title: "CTO" });
    person.close();

    const get = vi.spyOn(SharedPeople.prototype, "get");
    const query = vi.spyOn(Database.prototype, "query");
    const bulk = beta.listProspectsByIds(ids);
    expect(get).not.toHaveBeenCalled();
    // The rows joined to their people: one statement for the whole set.
    const statements = query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " "));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(
      /^SELECT p\.\*, .+ FROM prospects p LEFT JOIN \w+\.shared_people sp ON sp\.id = p\.shared_person_id WHERE p\.id IN \(\?,\?,\?,\?,\?\)$/,
    );
    // The chunk bound the issue states: 401 ids are two statements, not one.
    query.mockClear();
    expect(beta.listProspectsByIds(Array.from({ length: 401 }, (_, i) => 100_000 + i)).size).toBe(
      0,
    );
    expect(query).toHaveBeenCalledTimes(2);
    query.mockRestore();
    get.mockRestore();

    expect([...bulk.keys()].toSorted()).toEqual(ids.toSorted());
    for (const id of ids) expect(bulk.get(id)).toEqual(beta.getProspectById(id));
    expect(bulk.get(ids[2]!)!.title).toBe("CTO");

    // A row whose person the registry no longer holds shows its own values,
    // as getProspectById does for it.
    const gone = beta.getProspectById(ids[3]!)!.shared_person_id!;
    const registry = new Database(join(root, "shared.sqlite"));
    for (const table of ["person_aliases", "person_memberships"]) {
      registry.run(`DELETE FROM ${table} WHERE person_id = ?`, [gone]);
    }
    registry.run("DELETE FROM shared_people WHERE id = ?", [gone]);
    registry.close();
    const orphan = beta.listProspectsByIds([ids[3]!]).get(ids[3]!);
    expect(orphan).toEqual(beta.getProspectById(ids[3]!));
    expect(orphan).toMatchObject({ name: "Person 3", shared_person_id: gone });
  });

  it("listProspectsByIds on an anonymous ledger (#935) overlays shared people without the joined reader: no file for it to open", () => {
    const anonymous = new Ledger(":memory:", { sharedPeoplePath: join(root, "shared.sqlite") });
    try {
      const ids = [0, 1].map((i) =>
        anonymous.upsertProspect({ name: `Anon ${i}`, email: `anon-${i}@example.test` }),
      );
      const bulk = anonymous.listProspectsByIds(ids);
      expect([...bulk.keys()].toSorted()).toEqual(ids.toSorted());
      for (const id of ids) {
        expect(bulk.get(id)).toEqual(anonymous.getProspectById(id));
        expect(bulk.get(id)!.shared_person_id).toBeTruthy();
      }
    } finally {
      anonymous.close();
    }
  });

  it("reuses one person across workspaces and normalized identifiers", () => {
    const a = beta.upsertProspect({
      name: "Olga",
      email: " OLGA@example.test ",
      linkedin_url: "https://www.linkedin.com/in/Olga-Test/",
    });
    const b = alpha.upsertProspect({
      name: "Olga Kubli",
      linkedin_url: "https://linkedin.com/in/olga-test?trk=abc",
    });
    expect(beta.getProspectById(a)?.shared_person_id).toBe(
      alpha.getProspectById(b)?.shared_person_id,
    );
    expect(alpha.getProspectById(b)?.email).toBe("olga@example.test");
    expect(alpha.upsertProspect({ email: "olga@example.test" })).toBe(b);
    const db = new Database(join(root, "shared.sqlite"));
    try {
      expect(db.query("SELECT count(*) AS n FROM shared_people").get()).toEqual({ n: 1 });
      expect(db.query("SELECT count(*) AS n FROM person_memberships").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
  it("links a known person to a destination without copying product-specific research", () => {
    const a = beta.upsertProspect({
      name: "Person",
      email: "person@example.test",
      dossier_json: '{"product":"beta"}',
    });
    const personId = beta.getProspectById(a)!.shared_person_id!;
    const b = alpha.linkSharedProspect(personId);
    expect(alpha.linkSharedProspect(personId)).toBe(b);
    expect(alpha.getProspectById(b)?.dossier_json).toBeNull();
    alpha.setProspectDossier(b, '{"product":"alpha"}');
    expect(beta.getProspectById(a)?.dossier_json).toBe('{"product":"beta"}');
    alpha.setProspectCurrentRole(b, { company: "New company" });
    expect(beta.getProspectById(a)?.company).toBe("New company");
  });
  it("does not merge names or contradictory identifiers", () => {
    const a = beta.upsertProspect({ name: "Alex", email: "a@example.test" });
    const b = alpha.upsertProspect({
      name: "Alex",
      linkedin_url: "https://linkedin.com/in/someone-else",
    });
    expect(beta.getProspectById(a)?.shared_person_id).not.toBe(
      alpha.getProspectById(b)?.shared_person_id,
    );
    expect(() =>
      beta.upsertProspect({
        email: "a@example.test",
        linkedin_url: "https://linkedin.com/in/someone-else",
      }),
    ).toThrow("Conflicting person");
  });
  it("backfills legacy rows without changing their local IDs or dossiers", () => {
    const path = join(root, "legacy.sqlite");
    const legacy = new Ledger(path);
    const id = legacy.upsertProspect({
      name: "Existing",
      email: "existing@example.test",
      dossier_json: '{"kept":true}',
    });
    legacy.close();
    const other = beta.upsertProspect({ email: "existing@example.test" });
    const migrated = new Ledger(path, { sharedPeoplePath: join(root, "shared.sqlite") });
    try {
      expect(migrated.getProspectById(id)?.shared_person_id).toBe(
        beta.getProspectById(other)?.shared_person_id,
      );
      expect(migrated.getProspectById(id)?.dossier_json).toBe('{"kept":true}');
      expect(migrated.upsertProspect({ email: "existing@example.test" })).toBe(id);
    } finally {
      migrated.close();
    }
  });
  it("protects the same person from cross-workspace contact through another known email", () => {
    beta.upsertProspect({
      email: "old@example.test",
      linkedin_url: "https://linkedin.com/in/shared-person",
    });
    const alphaId = alpha.upsertProspect({
      email: "new@example.test",
      linkedin_url: "https://linkedin.com/in/shared-person",
    });
    expect(alpha.findProspectByEmail("new@example.test")?.id).toBe(alphaId);
    const shared = new SharedDb(join(root, "shared.sqlite"));
    try {
      shared.recordTouch({ email: "old@example.test", workspace: "beta", playName: "intro" });
      expect(shared.recentTouchElsewhere("new@example.test", "alpha")?.workspace).toBe("beta");
      expect(shared.touchesFor("new@example.test")).toHaveLength(1);
    } finally {
      shared.close();
    }
  });
  it("a do-not-contact call or an unsubscribe reply holds every verified address of the person", () => {
    beta.upsertProspect({
      email: "old@example.test",
      linkedin_url: "https://linkedin.com/in/opted-out",
    });
    const alphaId = alpha.upsertProspect({
      email: "new@example.test",
      linkedin_url: "https://linkedin.com/in/opted-out",
    });
    expect(alpha.contactSuppressionFor("old@example.test")).toBeNull();
    alpha.insertCall({
      prospectId: alphaId,
      startedAt: "2026-11-17T10:00:00.000Z",
      outcome: "do_not_contact",
    });
    expect(alpha.contactSuppressionFor("old@example.test")).toEqual({
      kind: "unsubscribe",
      received_at: "2026-11-17T10:00:00.000Z",
    });
    // A reply recorded against the person, from their other address.
    const other = beta.upsertProspect({
      email: "b-new@example.test",
      linkedin_url: "https://linkedin.com/in/replied-out",
    });
    const replied = alpha.upsertProspect({
      email: "b-old@example.test",
      linkedin_url: "https://linkedin.com/in/replied-out",
    });
    expect(beta.getProspectById(other)?.shared_person_id).toBe(
      alpha.getProspectById(replied)?.shared_person_id,
    );
    alpha.recordInboxReply({
      id: "u1",
      threadKey: "t",
      prospectId: replied,
      fromEmail: "b-old@example.test",
      body: "remove me",
      receivedAt: "2026-11-16T10:00:00.000Z",
      kind: "unsubscribe",
    });
    expect(alpha.contactSuppressionFor("b-new@example.test")).toMatchObject({
      kind: "unsubscribe",
    });
    // A dead mailbox holds that address only, never the person's others.
    const bounced = beta.upsertProspect({
      email: "c-new@example.test",
      linkedin_url: "https://linkedin.com/in/mailbox-gone",
    });
    const gone = alpha.upsertProspect({
      email: "c-old@example.test",
      linkedin_url: "https://linkedin.com/in/mailbox-gone",
    });
    expect(beta.getProspectById(bounced)?.shared_person_id).toBe(
      alpha.getProspectById(gone)?.shared_person_id,
    );
    alpha.recordInboxReply({
      id: "g1",
      threadKey: "t2",
      prospectId: gone,
      fromEmail: "c-new@example.test",
      body: "mailbox does not exist",
      receivedAt: "2026-11-16T11:00:00.000Z",
      kind: "auto_permanent",
    });
    expect(alpha.contactSuppressionFor("c-new@example.test")).toMatchObject({
      kind: "auto_permanent",
    });
    expect(alpha.contactSuppressionFor("c-old@example.test")).toBeNull();
    // An address nobody knows is not held.
    expect(alpha.contactSuppressionFor("stranger@example.test")).toBeNull();
  });
  /** People with two rows each, made before the registry: the backfill binds each pair to one person. */
  function aliasLedger(people: string[]): { ledger: Ledger; rows: Array<[number, number]> } {
    const path = join(root, "aliases.sqlite");
    const legacy = new Ledger(path);
    const rows = people.map((who): [number, number] => {
      const linkedin_url = `https://linkedin.com/in/${who}`;
      return [
        legacy.upsertProspect({ email: `${who}-1@example.test`, linkedin_url }),
        legacy.upsertProspect({ email: `${who}-2@example.test`, linkedin_url }),
      ];
    });
    legacy.close();
    const ledger = new Ledger(path, { sharedPeoplePath: join(root, "shared.sqlite") });
    for (const [first, second] of rows) {
      expect(ledger.getProspectById(first)?.shared_person_id).toBeTruthy();
      expect(ledger.getProspectById(second)?.shared_person_id).toBe(
        ledger.getProspectById(first)?.shared_person_id,
      );
    }
    return { ledger, rows };
  }
  it("an opt-out on one local row of a person holds their other rows here (legacy aliases)", () => {
    const { ledger, rows } = aliasLedger(["replied", "triaged", "called"]);
    const [[a1, a2], [b1, b2], [c1, c2]] = rows as [
      [number, number],
      [number, number],
      [number, number],
    ];
    try {
      expect(ledger.findProspectByEmail("replied-2@example.test")?.id).toBe(a2);
      ledger.recordInboxReply({
        id: "a1",
        threadKey: "t",
        prospectId: a1,
        fromEmail: "replied-1@example.test",
        body: "remove me",
        receivedAt: "2026-11-16T10:00:00.000Z",
        kind: "unsubscribe",
      });
      expect(ledger.contactSuppressionFor("replied-2@example.test")).toMatchObject({
        kind: "unsubscribe",
      });
      // An opt-out the sentiment triage read (intent), on the person's other row.
      ledger.recordInboxReply({
        id: "b1",
        threadKey: "t2",
        prospectId: b2,
        fromEmail: "triaged-2@example.test",
        body: "please stop",
        receivedAt: "2026-11-16T11:00:00.000Z",
        kind: "human",
      });
      ledger.setInboxReplyIntent("b1", "unsubscribe", null);
      ledger.insertCall({
        prospectId: c2,
        startedAt: "2026-11-17T10:00:00.000Z",
        outcome: "do_not_contact",
      });
      for (const id of [a1, a2, b1, b2, c1, c2]) expect(ledger.callAllowed(id)).toBe(false);
      expect(ledger.callAllowedIds([a1, a2, b1, b2, c1, c2])).toEqual(new Set());
      // Someone with no shared link still matches by id and address only.
      const solo = ledger.upsertProspect({ email: "solo@example.test" });
      expect(ledger.callAllowed(solo)).toBe(true);
      expect(ledger.callAllowedIds([solo])).toEqual(new Set([solo]));
    } finally {
      ledger.close();
    }
  });
  it("a wrong number logged on one row of a person is never offered on their other row", () => {
    const { ledger, rows } = aliasLedger(["dialled"]);
    const [[first, second]] = rows as [[number, number]];
    try {
      ledger.insertCall({
        prospectId: first,
        startedAt: "2026-11-17T10:00:00.000Z",
        outcome: "wrong_number",
        phone: "+15126531187",
      });
      expect(ledger.wrongNumbersFor([first, second])).toEqual(
        new Map([
          [first, new Set(["+15126531187"])],
          [second, new Set(["+15126531187"])],
        ]),
      );
    } finally {
      ledger.close();
    }
  });
  it("a wrong number is cleared from the shared person too, but a replacement there stays", () => {
    const linkedin_url = "https://linkedin.com/in/wrong-number";
    const a = alpha.upsertProspect({ email: "wn@example.test", linkedin_url });
    const b = beta.upsertProspect({
      email: "wn@example.test",
      linkedin_url,
      phone: "(512) 653-1187",
    });
    expect(alpha.getProspectById(a)?.phone).toBe("(512) 653-1187");
    expect(alpha.clearProspectPhone(a, "+15126531187")).toBe(true);
    expect(alpha.getProspectById(a)?.phone).toBeNull();
    expect(alpha.phoneForCall(a).phone).toBeNull();
    expect(beta.getProspectById(b)?.phone).toBeNull();
    // A replacement saved on the person since the call is kept.
    const person = alpha.getProspectById(a)!.shared_person_id!;
    const registry = new Database(join(root, "shared.sqlite"));
    registry.run("UPDATE shared_people SET phone = ? WHERE id = ?", ["+15126539999", person]);
    registry.close();
    alpha.clearProspectPhone(a, "+15126531187");
    expect(alpha.getProspectById(a)?.phone).toBe("+15126539999");
  });
  it("the call phone readers see a phone the shared person gained elsewhere", () => {
    const a = alpha.upsertProspect({
      email: "caller@example.test",
      linkedin_url: "https://linkedin.com/in/caller",
    });
    expect(alpha.phoneForCall(a).phone).toBeNull();
    // Another workspace finds the same person's number.
    beta.upsertProspect({
      email: "caller@example.test",
      linkedin_url: "https://linkedin.com/in/caller",
      phone: "+15126531187",
    });
    expect(alpha.getProspectById(a)?.phone).toBe("+15126531187");
    expect(alpha.phoneForCall(a).phone).toBe("+15126531187");
    expect(alpha.listCallCandidates({ limit: 10 })).toMatchObject([
      { prospectId: a, prospectPhone: "+15126531187" },
    ]);
  });

  it("keeps each workspace's original finder profile provenance", () => {
    const a = beta.upsertProspect({
      email: "same@example.test",
      source_profile_url: "https://linkedin.com/in/same-person",
    });
    const b = alpha.upsertProspect({
      email: "same@example.test",
      source_profile_url: "https://github.com/same-person",
    });
    expect(beta.getProspectById(a)?.shared_person_id).toBe(
      alpha.getProspectById(b)?.shared_person_id,
    );
    expect(alpha.getProspectById(b)?.source_profile_url).toBe("https://github.com/same-person");
  });
  it("validates a patch against stale local fields before applying canonical values", () => {
    const a = beta.upsertProspect({ email: "person@example.test" });
    const b = alpha.linkSharedProspect(beta.getProspectById(a)!.shared_person_id!);
    beta.updateProspectIdentity(a, { linkedin_url: "https://linkedin.com/in/correct-person" });
    beta.upsertProspect({
      email: "other@example.test",
      linkedin_url: "https://linkedin.com/in/other-person",
    });
    const raw = new Database(join(root, "alpha.sqlite"));
    try {
      expect(
        (
          raw.query("SELECT linkedin_url FROM prospects WHERE id=?").get(b) as {
            linkedin_url: string | null;
          }
        ).linkedin_url,
      ).toBeNull();
      expect(() =>
        alpha.updateProspectIdentity(b, { linkedin_url: "https://linkedin.com/in/other-person" }),
      ).toThrow("Conflicting person");
      alpha.updateProspectIdentity(b, { linkedin_url: "https://linkedin.com/in/new-handle" });
      expect(
        (
          raw.query("SELECT linkedin_url FROM prospects WHERE id=?").get(b) as {
            linkedin_url: string;
          }
        ).linkedin_url,
      ).toBe("https://linkedin.com/in/correct-person");
    } finally {
      raw.close();
    }
  });
});
