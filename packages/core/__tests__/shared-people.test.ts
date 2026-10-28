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
