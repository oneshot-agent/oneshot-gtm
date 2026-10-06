import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PLAY_DESCRIPTIONS } from "../src/descriptions.ts";
import { PLAYS } from "../src/registry.ts";

describe("play descriptions", () => {
  it("covers every registered play plus the voice/SMS CLI plays", () => {
    expect(Object.keys(PLAY_DESCRIPTIONS).toSorted()).toEqual(
      [...Object.keys(PLAYS), "concierge", "demo-no-show"].toSorted(),
    );
    const guide = readFileSync(new URL("../../../docs/plays.md", import.meta.url), "utf8");
    for (const [name, description] of Object.entries(PLAY_DESCRIPTIONS)) {
      expect(guide).toContain(`## ${name}`);
      for (const text of Object.values(description)) {
        expect(text.trim()).not.toBe("");
        expect(guide).toContain(text);
      }
    }
  });
});
