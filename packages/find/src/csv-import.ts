import { getLedger } from "@oneshot-gtm/core";
import { isDuplicate } from "./_dedupe.ts";
import { qualifyPerson, resolveIcp } from "./_filter.ts";

export const CSV_IMPORT_FIELDS = ["email", "name", "company", "title"] as const;
export type CsvImportField = (typeof CSV_IMPORT_FIELDS)[number];
export type CsvColumnMapping = Partial<Record<CsvImportField, string>>;

export interface CsvImportError {
  row: number;
  message: string;
}

export interface CsvImportResult {
  imported: number;
  skipped: number;
  errors: CsvImportError[];
}

/** Maximum number of source rows handled by one invocation. */
export const CSV_IMPORT_BATCH_LIMIT = 100;

export interface ParsedCsvImport {
  headers: string[];
  mapping: CsvColumnMapping;
  rows: string[][];
}

const HEADER_ALIASES: Record<CsvImportField, string[]> = {
  email: ["email", "emailaddress", "workemail", "businessemail", "founderemail"],
  name: ["name", "fullname", "contactname", "personname", "foundername"],
  company: ["company", "companyname", "organization", "organisation", "employer"],
  title: ["title", "jobtitle", "role", "position", "headline"],
};

const normalizeHeader = (value: string): string =>
  value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** RFC-4180-style parser, including quoted commas/newlines and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseMapOverrides(values: string[]): Record<string, CsvImportField> {
  const overrides: Record<string, CsvImportField> = {};
  for (const value of values) {
    const eq = value.indexOf("=");
    const column = value.slice(0, eq).trim();
    const field = value
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    if (eq < 1 || !CSV_IMPORT_FIELDS.includes(field as CsvImportField)) {
      throw new Error(`invalid --map '${value}'; expected column=email|name|company|title`);
    }
    overrides[normalizeHeader(column)] = field as CsvImportField;
  }
  return overrides;
}

export function prepareCsvImport(text: string, mapValues: string[] = []): ParsedCsvImport {
  const parsed = parseCsv(text);
  if (parsed.length === 0) throw new Error("CSV is empty");
  const headers = parsed[0]!.map((h) => h.replace(/^\uFEFF/, "").trim());
  if (headers.every((h) => h === "")) throw new Error("CSV header is empty");
  const normalizedHeaders = headers.map(normalizeHeader);
  const overrides = parseMapOverrides(mapValues);
  for (const column of Object.keys(overrides)) {
    if (!normalizedHeaders.includes(column)) throw new Error(`mapped column not found: ${column}`);
  }

  const mapping: CsvColumnMapping = {};
  // Explicit mappings win even when a different column happens to match an
  // alias (for example `Email` plus `Verified Email --map "Verified Email=email"`).
  for (let i = 0; i < headers.length; i++) {
    const normalized = normalizedHeaders[i]!;
    const override = overrides[normalized];
    if (override) mapping[override] = headers[i]!;
  }
  for (let i = 0; i < headers.length; i++) {
    const normalized = normalizedHeaders[i]!;
    const detected = CSV_IMPORT_FIELDS.find((field) => HEADER_ALIASES[field].includes(normalized));
    if (detected && mapping[detected] === undefined) mapping[detected] = headers[i]!;
  }
  if (!mapping.email) {
    throw new Error("could not detect an email column; use --map <column>=email");
  }
  return { headers, mapping, rows: parsed.slice(1) };
}

export async function importCsv(input: {
  text: string;
  playName: string;
  mapValues?: string[];
  dryRun?: boolean;
}): Promise<CsvImportResult & { mapping: CsvColumnMapping; rowCount: number }> {
  const prepared = prepareCsvImport(input.text, input.mapValues);
  const result: CsvImportResult = { imported: 0, skipped: 0, errors: [] };
  const indexes = Object.fromEntries(
    Object.entries(prepared.mapping).map(([field, column]) => [
      field,
      prepared.headers.indexOf(column),
    ]),
  ) as Partial<Record<CsvImportField, number>>;

  const admitted: Array<{ row: number; payload: Record<string, string>; email: string }> = [];
  const batch = prepared.rows.slice(0, CSV_IMPORT_BATCH_LIMIT);
  for (let i = 0; i < batch.length; i++) {
    const values = batch[i]!;
    if (values.every((v) => v.trim() === "")) {
      result.skipped++;
      result.errors.push({ row: i + 2, message: "empty row" });
      continue;
    }
    if (values.length !== prepared.headers.length) {
      result.skipped++;
      result.errors.push({
        row: i + 2,
        message: `expected ${prepared.headers.length} columns, found ${values.length}`,
      });
      continue;
    }
    const payload: Record<string, string> = {};
    for (const field of CSV_IMPORT_FIELDS) {
      const index = indexes[field];
      if (index !== undefined) {
        const value = (values[index] ?? "").trim();
        if (value) payload[field] = value;
      }
    }
    const email = (payload.email ?? "").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      result.skipped++;
      result.errors.push({ row: i + 2, message: "missing or invalid email" });
      continue;
    }
    payload.email = email;
    admitted.push({ row: i + 2, payload, email });
  }

  // Check the persisted queue first, then remember candidates admitted during
  // this invocation. The local set gives dry runs the same within-file dedupe
  // behavior that enqueueTarget provides to a live run.
  const unique: typeof admitted = [];
  const seen = new Set<string>();
  for (const candidate of admitted) {
    const dedupeKey = `email:${candidate.email}`;
    if (
      seen.has(dedupeKey) ||
      isDuplicate({ playName: input.playName, dedupeKey, prospectEmail: candidate.email })
    ) {
      result.skipped++;
      continue;
    }
    seen.add(dedupeKey);
    unique.push(candidate);
  }

  // A dry run is deliberately side-effect and spend free. Dedupe is simulated
  // above, but the potentially paid person classifier is never invoked.
  if (input.dryRun) {
    result.imported = unique.length;
    return { ...result, mapping: prepared.mapping, rowCount: batch.length };
  }

  const icp = resolveIcp();
  const ledger = getLedger();
  for (const candidate of unique) {
    const verdict = await qualifyPerson({
      icp,
      person: {
        name: candidate.payload.name,
        company: candidate.payload.company,
        roleText: candidate.payload.title,
        evidence: "CSV import",
      },
    });
    if (verdict.verdict === "reject" || verdict.verdict === "transient") {
      result.skipped++;
      if (verdict.verdict === "transient") {
        result.errors.push({ row: candidate.row, message: verdict.reason });
      }
      continue;
    }
    const dedupeKey = `email:${candidate.email}`;
    const id = ledger.enqueueTarget({
      playName: input.playName,
      payload: candidate.payload,
      dedupeKey,
      source: "find:csv-import",
    });
    if (id == null) result.skipped++;
    else result.imported++;
  }
  return { ...result, mapping: prepared.mapping, rowCount: batch.length };
}
