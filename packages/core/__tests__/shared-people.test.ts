import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SharedDb } from "../src/shared-db.ts";
import { Ledger } from "../src/ledger.ts";

let root: string;
let sdk: Ledger;
let gtm: Ledger;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shared-people-"));
  const options = { sharedPeoplePath: join(root, "shared.sqlite") };
  sdk = new Ledger(join(root, "sdk.sqlite"), options);
  gtm = new Ledger(join(root, "gtm.sqlite"), options);
});
afterEach(() => {
  sdk.close();
  gtm.close();
  rmSync(root, { recursive: true, force: true });
});

describe("shared person identity with workspace memberships", () => {
  it("reuses one person across workspaces and normalized identifiers", () => {
    const a = sdk.upsertProspect({
      name: "Olga",
      email: " OLGA@example.test ",
      linkedin_url: "https://www.linkedin.com/in/Olga-Test/",
    });
    const b = gtm.upsertProspect({
      name: "Olga Kubli",
      linkedin_url: "https://linkedin.com/in/olga-test?trk=abc",
    });
    expect(sdk.getProspectById(a)?.shared_person_id).toBe(gtm.getProspectById(b)?.shared_person_id);
    expect(gtm.getProspectById(b)?.email).toBe("olga@example.test");
    expect(gtm.upsertProspect({ email: "olga@example.test" })).toBe(b);
    const db = new Database(join(root, "shared.sqlite"));
    try {
      expect(db.query("SELECT count(*) AS n FROM shared_people").get()).toEqual({ n: 1 });
      expect(db.query("SELECT count(*) AS n FROM person_memberships").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
  it("links a known person to a destination without copying product-specific research", () => {
    const a = sdk.upsertProspect({
      name: "Person",
      email: "person@example.test",
      dossier_json: '{"product":"sdk"}',
    });
    const personId = sdk.getProspectById(a)!.shared_person_id!;
    const b = gtm.linkSharedProspect(personId);
    expect(gtm.linkSharedProspect(personId)).toBe(b);
    expect(gtm.getProspectById(b)?.dossier_json).toBeNull();
    gtm.setProspectDossier(b, '{"product":"gtm"}');
    expect(sdk.getProspectById(a)?.dossier_json).toBe('{"product":"sdk"}');
    gtm.setProspectCurrentRole(b, { company: "New company" });
    expect(sdk.getProspectById(a)?.company).toBe("New company");
  });
  it("does not merge names or contradictory identifiers", () => {
    const a = sdk.upsertProspect({ name: "Alex", email: "a@example.test" });
    const b = gtm.upsertProspect({
      name: "Alex",
      linkedin_url: "https://linkedin.com/in/someone-else",
    });
    expect(sdk.getProspectById(a)?.shared_person_id).not.toBe(
      gtm.getProspectById(b)?.shared_person_id,
    );
    expect(() =>
      sdk.upsertProspect({
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
    const other = sdk.upsertProspect({ email: "existing@example.test" });
    const migrated = new Ledger(path, { sharedPeoplePath: join(root, "shared.sqlite") });
    try {
      expect(migrated.getProspectById(id)?.shared_person_id).toBe(
        sdk.getProspectById(other)?.shared_person_id,
      );
      expect(migrated.getProspectById(id)?.dossier_json).toBe('{"kept":true}');
      expect(migrated.upsertProspect({ email: "existing@example.test" })).toBe(id);
    } finally {
      migrated.close();
    }
  });
  it("protects the same person from cross-workspace contact through another known email", () => {
    sdk.upsertProspect({
      email: "old@example.test",
      linkedin_url: "https://linkedin.com/in/shared-person",
    });
    const gtmId = gtm.upsertProspect({
      email: "new@example.test",
      linkedin_url: "https://linkedin.com/in/shared-person",
    });
    expect(gtm.findProspectByEmail("new@example.test")?.id).toBe(gtmId);
    const shared = new SharedDb(join(root, "shared.sqlite"));
    try {
      shared.recordTouch({ email: "old@example.test", workspace: "sdk", playName: "intro" });
      expect(shared.recentTouchElsewhere("new@example.test", "gtm")?.workspace).toBe("sdk");
      expect(shared.touchesFor("new@example.test")).toHaveLength(1);
    } finally {
      shared.close();
    }
  });
  it("keeps each workspace's original finder profile provenance", () => {
    const a = sdk.upsertProspect({
      email: "same@example.test",
      source_profile_url: "https://linkedin.com/in/same-person",
    });
    const b = gtm.upsertProspect({
      email: "same@example.test",
      source_profile_url: "https://github.com/same-person",
    });
    expect(sdk.getProspectById(a)?.shared_person_id).toBe(gtm.getProspectById(b)?.shared_person_id);
    expect(gtm.getProspectById(b)?.source_profile_url).toBe("https://github.com/same-person");
  });
});
