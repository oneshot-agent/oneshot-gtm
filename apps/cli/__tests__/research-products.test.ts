import { describe, expect, it } from "vitest";
import {
  hasProductResearch,
  productQueueStatuses,
  selectProductQueueRows,
} from "../src/commands/research-products.ts";

// Which queue rows a company-research backfill covers. `--include-unsent`
// adds approved rows to pending ones; a sent or sending row is never
// researched onto, and a row is bought twice only when asked.

function row(payload: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    play_name: "design-partner-loi",
    payload_json: JSON.stringify(payload),
    sent_at: null as string | null,
    send_started_at: null as string | null,
    ...over,
  };
}

describe("productQueueStatuses", () => {
  it("is pending by default, pending and approved with --include-unsent, none without either", () => {
    expect(productQueueStatuses({ includePending: true })).toEqual(["pending"]);
    expect(productQueueStatuses({ includePending: true, includeUnsent: true })).toEqual([
      "pending",
      "approved",
    ]);
    expect(productQueueStatuses({ includePending: false, includeUnsent: true })).toEqual([
      "pending",
      "approved",
    ]);
    expect(productQueueStatuses({ includePending: false })).toEqual([]);
  });
});

describe("selectProductQueueRows", () => {
  const old = "2026-01-01T00:00:00.000Z";
  const noPages = { status: "partial", researchedAt: old, sources: [], external: {} };
  const pages = {
    status: "partial",
    researchedAt: old,
    sources: [{ url: "https://alpha.example", excerpt: "Alpha builds search" }],
  };

  it("takes a row with no research, or a company to read and research without its outside half", () => {
    const fresh = row({ companyDomain: "alpha.example" });
    const pageless = row({ companyDomain: "alpha.example", productResearch: noPages });
    // A homepage read alone is partial: the outside research is still missing.
    const homepage = row({ companyDomain: "alpha.example", productResearch: pages });
    const complete = row({
      companyDomain: "alpha.example",
      productResearch: { ...pages, status: "complete", external: { answer: "a" } },
    });
    const builder = row({ email: "ada@gmail.com", productResearch: noPages });
    expect(
      selectProductQueueRows([fresh, pageless, homepage, complete, builder], { refresh: false }),
    ).toEqual([fresh, pageless, homepage]);
    expect(selectProductQueueRows([complete, builder], { refresh: true })).toEqual([
      complete,
      builder,
    ]);
  });

  it("never a sent or sending row", () => {
    const sent = row({}, { sent_at: "2026-10-01T00:00:00Z" });
    const sending = row({}, { send_started_at: "2026-10-01T00:00:00Z" });
    expect(selectProductQueueRows([sent, sending], { refresh: true })).toEqual([]);
  });
});

describe("hasProductResearch", () => {
  it("says whether a failed lookup would replace research the row already has", () => {
    expect(hasProductResearch(JSON.stringify({ productResearch: { status: "partial" } }))).toBe(
      true,
    );
    expect(hasProductResearch(JSON.stringify({ companyDomain: "alpha.example" }))).toBe(false);
    expect(hasProductResearch("not json")).toBe(false);
  });
});
