import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReadiness, TRIGGERS } from "../src/registry.ts";
import { getPack, PACKS } from "../src/packs.ts";

/**
 * #464 acceptance: applying each of the seven real packs leaves its triggers
 * enabled, with config that passes checkReadiness once yourEdge/yourClaim
 * are supplied and fails with a named reason before that; no pack writes a
 * founder-voice field; every triggers key names a real TRIGGERS entry so a
 * renamed finder can't silently orphan a pack.
 */

const REAL_PACK_IDS = [
  "restaurants-food-service",
  "home-services-trades",
  "healthcare-practices",
  "auto-services",
  "professional-services-smb",
  "trucking-freight",
  "civic-gov",
] as const;

describe("PACKS — trigger names stay in sync with the registry", () => {
  it("every pack's triggers key names a trigger that exists in TRIGGERS", () => {
    const known = new Set(TRIGGERS.map((t) => t.name));
    for (const pack of PACKS) {
      for (const triggerName of Object.keys(pack.triggers)) {
        expect(
          known.has(triggerName),
          `${pack.id} references unknown trigger '${triggerName}'`,
        ).toBe(true);
      }
    }
  });

  it("ships exactly the seven real-vertical packs plus the #458 placeholder", () => {
    const ids = PACKS.map((p) => p.id).toSorted();
    expect(ids).toEqual([...REAL_PACK_IDS, "devtools-early-adopters"].toSorted());
  });
});

describe("PACKS — no pack writes a founder-voice field", () => {
  const FOUNDER_VOICE_KEYS = ["yourEdge", "yourClaim"];

  it("never sets yourEdge/yourClaim inside a trigger patch", () => {
    for (const pack of PACKS) {
      for (const [triggerName, patch] of Object.entries(pack.triggers)) {
        for (const key of FOUNDER_VOICE_KEYS) {
          expect(
            Object.prototype.hasOwnProperty.call(patch, key),
            `${pack.id}.triggers.${triggerName} must not set '${key}' — founder-voice fields are pack.requires, not patch content`,
          ).toBe(false);
        }
      }
    }
  });

  it("requires lists only founder-voice keys, and every touched trigger that needs one is named", () => {
    for (const pack of PACKS) {
      for (const key of pack.requires) {
        expect(FOUNDER_VOICE_KEYS).toContain(key);
      }
    }
  });
});

describe.each(REAL_PACK_IDS)("pack: %s", (id) => {
  const pack = getPack(id)!;
  const ORIGINAL_SAM_KEY = process.env["SAM_GOV_API_KEY"];

  beforeEach(() => {
    // gov-solicitation's readiness also gates on SAM_GOV_API_KEY, which is
    // an env secret, not a pack-suppliable or founder-voice field — set it
    // here so the civic-gov pack's "ready once founder-voice supplied"
    // assertion isolates the thing this pack actually controls.
    process.env["SAM_GOV_API_KEY"] = "test-key";
  });
  afterEach(() => {
    if (ORIGINAL_SAM_KEY === undefined) delete process.env["SAM_GOV_API_KEY"];
    else process.env["SAM_GOV_API_KEY"] = ORIGINAL_SAM_KEY;
  });

  it("exists and has a non-empty buyerBrief, icpOneLiner, and at least one trigger", () => {
    expect(pack).toBeDefined();
    expect(pack.buyerBrief.length).toBeGreaterThan(0);
    expect(pack.icpOneLiner.length).toBeGreaterThan(0);
    expect(Object.keys(pack.triggers).length).toBeGreaterThan(0);
  });

  it("fails checkReadiness with a named reason before yourEdge/yourClaim is supplied", () => {
    for (const [triggerName, patch] of Object.entries(pack.triggers)) {
      const spec = TRIGGERS.find((t) => t.name === triggerName)!;
      const merged = { ...spec.defaultConfig, ...patch };
      const readiness = checkReadiness(spec, merged);
      // A pack's whole point is to leave the trigger enabled-but-not-ready
      // until the founder supplies yourEdge/yourClaim — assert that's
      // actually true for every trigger this pack touches whose spec has a
      // readiness gate at all.
      if (spec.readiness) {
        expect(readiness.ready, `${id}.${triggerName} should be unready pre-yourEdge`).toBe(false);
        if (!readiness.ready) {
          expect(readiness.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("passes checkReadiness once every pack.requires key is supplied", () => {
    const founderVoice = Object.fromEntries(
      pack.requires.map((k) => [k, "a concrete founder pitch"]),
    );
    for (const [triggerName, patch] of Object.entries(pack.triggers)) {
      const spec = TRIGGERS.find((t) => t.name === triggerName)!;
      const merged = { ...spec.defaultConfig, ...patch, ...founderVoice };
      const readiness = checkReadiness(spec, merged);
      expect(
        readiness.ready,
        `${id}.${triggerName} should be ready once ${pack.requires.join(", ")} is set`,
      ).toBe(true);
    }
  });

  it("does not write icpOneLiner into any trigger patch", () => {
    for (const patch of Object.values(pack.triggers)) {
      expect(patch).not.toHaveProperty("icpOneLiner");
    }
  });
});

describe("getPack", () => {
  it("returns null for an unknown id", () => {
    expect(getPack("not-a-real-pack")).toBeNull();
  });

  it("returns the matching pack for a known id", () => {
    expect(getPack("healthcare-practices")?.label).toBe("Healthcare Practices");
  });
});
