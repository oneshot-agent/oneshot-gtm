import { describe, expect, it } from "vitest";
import { RUNNABLE_PLAYS } from "@oneshot-gtm/shared-types";
import { PLAY_SCHEMAS } from "../src/lib/playSchemas";

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
