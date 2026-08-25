import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-identity-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("updateProspectIdentity", () => {
  it("fills a column that is currently NULL", () => {
    const id = ledger.upsertProspect({ name: "Ada Lovelace", email: "ada@acme.dev" });
    expect(ledger.getProspectById(id)?.linkedin_url).toBeNull();

    expect(
      ledger.updateProspectIdentity(id, { linkedin_url: "https://www.linkedin.com/in/ada" }),
    ).toBe(true);
    expect(ledger.getProspectById(id)?.linkedin_url).toBe("https://www.linkedin.com/in/ada");
  });

  it("never overwrites a value a finder already resolved", () => {
    const id = ledger.upsertProspect({
      name: "Ada",
      email: "ada@acme.dev",
      linkedin_url: "https://www.linkedin.com/in/authoritative",
    });
    // A backfill hit must lose to the finder's value — a real Luma handle beats
    // a fuzzy web-search result.
    expect(
      ledger.updateProspectIdentity(id, { linkedin_url: "https://www.linkedin.com/in/guess" }),
    ).toBe(false);
    expect(ledger.getProspectById(id)?.linkedin_url).toBe(
      "https://www.linkedin.com/in/authoritative",
    );
  });

  it("reports false for a no-op instead of counting the matched row", () => {
    const id = ledger.upsertProspect({
      name: "Ada",
      email: "ada@acme.dev",
      phone: "+15551234567",
    });
    // SQLite's `changes` counts matched rows, so a naive implementation would
    // return true here and over-report how much the backfill filled in.
    expect(ledger.updateProspectIdentity(id, { phone: "+15559999999" })).toBe(false);
  });

  it("ignores empty patches and blank strings", () => {
    const id = ledger.upsertProspect({ name: "Ada", email: "ada@acme.dev" });
    expect(ledger.updateProspectIdentity(id, {})).toBe(false);
    expect(ledger.updateProspectIdentity(id, { linkedin_url: "   " })).toBe(false);
    expect(ledger.getProspectById(id)?.linkedin_url).toBeNull();
  });

  it("fills a column holding an empty string, not just NULL", () => {
    // listProspectsMissingLinkedIn counts '' as missing, so the write path has
    // to agree. A bare COALESCE matches the row, reports a change, and leaves
    // the '' in place — a silent no-op the caller counts as a success.
    const id = ledger.upsertProspect({ name: "Ada", email: "ada@acme.dev", linkedin_url: "" });
    expect(ledger.getProspectById(id)?.linkedin_url).toBe("");
    expect(
      ledger.updateProspectIdentity(id, { linkedin_url: "https://www.linkedin.com/in/ada" }),
    ).toBe(true);
    expect(ledger.getProspectById(id)?.linkedin_url).toBe("https://www.linkedin.com/in/ada");
  });

  it("fills several columns in one call", () => {
    const id = ledger.upsertProspect({ name: "Ada", email: "ada@acme.dev" });
    expect(
      ledger.updateProspectIdentity(id, {
        linkedin_url: "https://www.linkedin.com/in/ada",
        company: "Acme",
        source_profile_url: "https://github.com/ada",
      }),
    ).toBe(true);
    const row = ledger.getProspectById(id);
    expect(row?.company).toBe("Acme");
    expect(row?.source_profile_url).toBe("https://github.com/ada");
  });

  it("fills the empty column when another in the same patch is already set", () => {
    const id = ledger.upsertProspect({ name: "Ada", email: "ada@acme.dev", company: "Acme" });
    expect(
      ledger.updateProspectIdentity(id, {
        company: "Wrong Corp",
        linkedin_url: "https://www.linkedin.com/in/ada",
      }),
    ).toBe(true);
    const row = ledger.getProspectById(id);
    expect(row?.company).toBe("Acme");
    expect(row?.linkedin_url).toBe("https://www.linkedin.com/in/ada");
  });
});

describe("upsertProspect", () => {
  it("persists source_profile_url so a later re-enrichment has a strong key", () => {
    const id = ledger.upsertProspect({
      name: "Ada",
      email: "ada@acme.dev",
      source_profile_url: "https://github.com/ada",
    });
    expect(ledger.getProspectById(id)?.source_profile_url).toBe("https://github.com/ada");
  });
});

describe("listProspectsMissingLinkedIn", () => {
  it("returns only rows with an empty linkedin_url and a usable name", () => {
    ledger.upsertProspect({
      name: "Has One",
      email: "a@x.dev",
      linkedin_url: "https://www.linkedin.com/in/x",
    });
    const missing = ledger.upsertProspect({ name: "Needs One", email: "b@x.dev" });
    ledger.upsertProspect({ name: null, email: "c@x.dev" }); // nameless — nothing to search

    expect(ledger.listProspectsMissingLinkedIn().map((r) => r.id)).toEqual([missing]);
  });

  it("skips rows whose column deliberately holds a GitHub/X URL", () => {
    // profile-intro stores whichever social link it has in this column, and
    // updateProspectIdentity won't overwrite it — so reporting these would just
    // produce phantom candidates the backfill pays for and can't write.
    ledger.upsertProspect({
      name: "Gh User",
      email: "g@x.dev",
      linkedin_url: "https://github.com/ghuser",
    });
    expect(ledger.listProspectsMissingLinkedIn()).toHaveLength(0);
  });

  it("filters by originating play", () => {
    const repo = ledger.upsertProspect({
      name: "Repo Person",
      email: "r@x.dev",
      source: "repo-interest",
    });
    ledger.upsertProspect({ name: "Luma Person", email: "l@x.dev", source: "luma-events" });

    expect(ledger.listProspectsMissingLinkedIn({ play: "repo-interest" }).map((r) => r.id)).toEqual(
      [repo],
    );
  });

  it("honours the limit", () => {
    for (let i = 0; i < 5; i++) ledger.upsertProspect({ name: `P ${i}`, email: `p${i}@x.dev` });
    expect(ledger.listProspectsMissingLinkedIn({ limit: 2 })).toHaveLength(2);
  });
});

describe("prospects.title — insert + backfill (person-level ICP gate)", () => {
  it("persists title on insert and returns it on read", () => {
    const id = ledger.upsertProspect({
      name: "Ada Lovelace",
      email: "ada2@acme.dev",
      title: "Staff Engineer",
    });
    expect(ledger.getProspectById(id)?.title).toBe("Staff Engineer");
  });

  it("defaults to NULL when omitted (pre-gate rows keep their meaning)", () => {
    const id = ledger.upsertProspect({ name: "Sam", email: "sam2@acme.dev" });
    expect(ledger.getProspectById(id)?.title).toBeNull();
  });

  it("backfills via updateProspectIdentity without clobbering an existing title", () => {
    // The Phase-5 audit path: score history, write titles onto old rows.
    const id = ledger.upsertProspect({ name: "Nick", email: "nick@x.dev" });
    expect(ledger.updateProspectIdentity(id, { title: "Manager" })).toBe(true);
    expect(ledger.getProspectById(id)?.title).toBe("Manager");
    // COALESCE semantics: a later fuzzy lookup must not overwrite a title the
    // gate already judged on.
    expect(ledger.updateProspectIdentity(id, { title: "Intern" })).toBe(false);
    expect(ledger.getProspectById(id)?.title).toBe("Manager");
  });
});
