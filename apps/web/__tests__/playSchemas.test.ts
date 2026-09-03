import { describe, expect, it } from "vitest";
import { RUNNABLE_PLAYS } from "@oneshot-gtm/shared-types";
import { missingRequiredExtras, missingRequiredFields, PLAY_SCHEMAS } from "../src/lib/playSchemas";

// The list and the schemas are edited in different files by different features,
// and they drifted twice before this test existed: /queue's drain list lost
// luma-events, the Plays page's copy lost competitor-switch. RUNNABLE_PLAYS is
// now the single source of truth (the server's /api/run gate reads it), so a
// play in the list with no form schema would render "not supported" after the
// founder clicks through, and a schema with no listing would 400 at the server.
describe("PLAY_SCHEMAS vs RUNNABLE_PLAYS", () => {
  it("covers exactly the runnable plays", () => {
    expect(Object.keys(PLAY_SCHEMAS).toSorted()).toEqual([...RUNNABLE_PLAYS].toSorted());
  });

  it("gives every schema at least one field and a default row", () => {
    for (const [name, schema] of Object.entries(PLAY_SCHEMAS)) {
      expect(schema.fields.length, `${name} has no fields`).toBeGreaterThan(0);
      // Every field must be addressable from defaultRow, else hydration from a
      // queue row silently drops it.
      for (const f of schema.fields) {
        expect(schema.defaultRow, `${name}.${f.key} missing from defaultRow`).toHaveProperty(f.key);
      }
    }
  });
});

// finding PRRT_kwDOSKzrBs6ewQc8: /run's rows render outside a <form>, so the
// `required` attribute on each field is decorative — this pure helper is
// what actually blocks dispatch (wired into run.$playName.tsx's submit()).
describe("missingRequiredFields", () => {
  const schema = PLAY_SCHEMAS["sources-sought"]!;

  it("lists the labels of blank required fields", () => {
    const row = { ...schema.defaultRow, name: "Jane Doe", email: "jane@agency.gov" };
    const missing = missingRequiredFields(schema, row);
    expect(missing).toContain("Agency");
    expect(missing).toContain("Notice number");
    expect(missing).toContain("Notice type");
    expect(missing).toContain("Notice title");
    expect(missing).toContain("Your edge (one sentence)");
  });

  it("treats whitespace-only values as blank", () => {
    const row = {
      ...schema.defaultRow,
      name: "Jane Doe",
      email: "jane@agency.gov",
      agency: "   ",
    };
    expect(missingRequiredFields(schema, row)).toContain("Agency");
  });

  it("returns no missing fields when every required key is filled", () => {
    const row: Record<string, string> = { ...schema.defaultRow };
    for (const f of schema.fields) {
      if (f.required) row[f.key] = "x";
    }
    expect(missingRequiredFields(schema, row)).toEqual([]);
  });

  it("ignores optional fields left blank", () => {
    const row: Record<string, string> = { ...schema.defaultRow };
    for (const f of schema.fields) {
      if (f.required) row[f.key] = "x";
    }
    expect(row["requirementSummary"]).toBe("");
    expect(missingRequiredFields(schema, row)).toEqual([]);
  });
});

// finding PRRT_kwDOSKzrBs6ewsAf: missingRequiredFields only ever filtered
// schema.fields — a required EXTRA (accelerator-batch's senderCohort) passed
// validation blank and reached /api/run omitted, a paid malformed draft.
describe("missingRequiredExtras", () => {
  const schema = PLAY_SCHEMAS["accelerator-batch"]!;

  it("flags a blank required extra (senderCohort)", () => {
    expect(missingRequiredExtras(schema, {})).toContain("Your cohort tag (sender)");
  });

  it("treats whitespace-only extras as blank", () => {
    expect(missingRequiredExtras(schema, { senderCohort: "   " })).toContain(
      "Your cohort tag (sender)",
    );
  });

  it("passes once the required extra is filled, ignoring the optional one", () => {
    expect(missingRequiredExtras(schema, { senderCohort: "yc-w23" })).toEqual([]);
  });

  it("returns [] for a schema with no extras", () => {
    const noExtras = PLAY_SCHEMAS["show-hn"]!;
    expect(missingRequiredExtras(noExtras, {})).toEqual([]);
  });
});

// finding PRRT_kwDOSKzrBs6fD-hS/hc / issue #463: civic-pilot's pilot must be
// sized under the micro-purchase threshold OR bought off a cooperative
// purchasing vehicle — a bare per-field `required` on purchasingVehicle would
// force fabricating a vehicle for a threshold-only target.
describe("missingRequiredFields — requireOneOf (civic-pilot purchasing route)", () => {
  const schema = PLAY_SCHEMAS["civic-pilot"]!;

  it("flags the OR-group when neither route is filled", () => {
    const row = { ...schema.defaultRow };
    expect(missingRequiredFields(schema, row)).toContain(
      "Purchasing vehicle or micro-purchase threshold",
    );
  });

  it("passes when only purchasingVehicle is filled", () => {
    const row: Record<string, string> = { ...schema.defaultRow, purchasingVehicle: "Sourcewell" };
    for (const f of schema.fields) {
      if (f.required) row[f.key] = row[f.key] || "x";
    }
    expect(missingRequiredFields(schema, row)).not.toContain(
      "Purchasing vehicle or micro-purchase threshold",
    );
  });

  it("passes when only microPurchaseThreshold is filled", () => {
    const row: Record<string, string> = {
      ...schema.defaultRow,
      microPurchaseThreshold: "$10,000",
    };
    for (const f of schema.fields) {
      if (f.required) row[f.key] = row[f.key] || "x";
    }
    expect(missingRequiredFields(schema, row)).not.toContain(
      "Purchasing vehicle or micro-purchase threshold",
    );
  });
});
