import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SharedDb } from "../src/shared-db.ts";
import { Ledger } from "../src/ledger.ts";

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
