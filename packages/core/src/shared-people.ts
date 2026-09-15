import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Canonical person identity. Workspace prospect IDs remain stable history/membership keys. */
export interface SharedPerson {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  linkedin_url: string | null;
  source_profile_url: string | null;
  title: string | null;
}
const fields = [
  "name",
  "email",
  "phone",
  "company",
  "linkedin_url",
  "source_profile_url",
  "title",
] as const;
export function personAliases(input: Partial<Omit<SharedPerson, "id">>): string[] {
  const keys: string[] = [];
  if (input.email?.trim()) keys.push(`email:${input.email.trim().toLowerCase()}`);
  for (const raw of [input.linkedin_url, input.source_profile_url]) {
    if (!raw) continue;
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const match = /^\/in\/([^/]+)\/?$/i.exec(url.pathname);
      if (/^(?:[a-z]+\.)?linkedin\.com$/i.test(url.hostname) && match?.[1])
        keys.push(`linkedin:${decodeURIComponent(match[1]).toLowerCase()}`);
    } catch {
      /* An invalid or non-person URL is not an identity key. */
    }
  }
  return [...new Set(keys)];
}

export class SharedPeople {
  private db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_people (
        id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, company TEXT,
        linkedin_url TEXT, source_profile_url TEXT, title TEXT
      );
      CREATE TABLE IF NOT EXISTS person_aliases (
        alias TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES shared_people(id)
      );
      CREATE TABLE IF NOT EXISTS person_memberships (
        ledger_path TEXT NOT NULL, prospect_id INTEGER NOT NULL, person_id TEXT NOT NULL,
        PRIMARY KEY(ledger_path, prospect_id)
      );
      CREATE INDEX IF NOT EXISTS person_memberships_person ON person_memberships(person_id);
    `);
  }
  version(): string {
    return JSON.stringify([
      this.db.query("PRAGMA data_version").get(),
      this.db.query("SELECT total_changes() n").get(),
    ]);
  }
  get(id: string): SharedPerson | null {
    return this.db.query("SELECT * FROM shared_people WHERE id=?").get(id) as SharedPerson | null;
  }
  find(input: Partial<Omit<SharedPerson, "id">>): SharedPerson | null {
    const ids = new Set(
      personAliases(input).flatMap((alias) => {
        const row = this.db
          .query("SELECT person_id FROM person_aliases WHERE alias=?")
          .get(alias) as { person_id: string } | null;
        return row ? [row.person_id] : [];
      }),
    );
    return ids.size === 1 ? this.get([...ids][0]!) : null;
  }
  /** Never merge two existing people based on a contradictory incoming identifier. */
  resolve(input: Partial<Omit<SharedPerson, "id">>, knownId?: string): SharedPerson {
    return this.db
      .transaction(() => {
        const keys = personAliases(input);
        const matches = new Set(
          keys.flatMap((key) => {
            const row = this.db
              .query("SELECT person_id FROM person_aliases WHERE alias=?")
              .get(key) as { person_id: string } | null;
            return row ? [row.person_id] : [];
          }),
        );
        if (knownId) {
          if (!this.get(knownId)) throw Error("Shared person does not exist");
          matches.add(knownId);
        }
        if (matches.size > 1)
          throw Error(
            "Conflicting person identifiers; review the existing people before linking them",
          );
        const id = [...matches][0] ?? randomUUID();
        this.db.query("INSERT OR IGNORE INTO shared_people(id) VALUES (?)").run(id);
        for (const field of fields) {
          const value = input[field]?.trim();
          if (value)
            this.db
              .query(`UPDATE shared_people SET ${field}=COALESCE(NULLIF(${field},''),?) WHERE id=?`)
              .run(field === "email" ? value.toLowerCase() : value, id);
        }
        for (const key of keys)
          this.db
            .query("INSERT OR IGNORE INTO person_aliases(alias,person_id) VALUES (?,?)")
            .run(key, id);
        return this.get(id)!;
      })
      .immediate();
  }
  link(ledgerPath: string, prospectId: number, personId: string): void {
    this.db
      .query(
        "INSERT INTO person_memberships VALUES (?,?,?) ON CONFLICT(ledger_path,prospect_id) DO UPDATE SET person_id=excluded.person_id",
      )
      .run(ledgerPath, prospectId, personId);
  }
  membership(ledgerPath: string, prospectId: number): string | undefined {
    return (
      this.db
        .query("SELECT person_id FROM person_memberships WHERE ledger_path=? AND prospect_id=?")
        .get(ledgerPath, prospectId) as { person_id: string } | null
    )?.person_id;
  }
  setRole(id: string, patch: { company?: string; title?: string }): void {
    for (const field of ["company", "title"] as const)
      if (patch[field]?.trim())
        this.db
          .query(`UPDATE shared_people SET ${field}=? WHERE id=?`)
          .run(patch[field]!.trim(), id);
  }
  close(): void {
    this.db.close();
  }
}
