/**
 * Industry packs: a working starting config for a founder's vertical, handed
 * over in one shot instead of the strategist proposing one `apply-config`
 * marker per trigger (`packages/prompts/strategist-trigger.md`: "ONE marker
 * per message"). A pack bundles config patches for several triggers at once
 * plus the buyer framing behind them — `TriggerSpec.defaultConfig` already
 * carries generic per-trigger defaults; a pack is a curated OVERLAY on top,
 * anchored in one vertical.
 *
 * See #458. Ships with a single placeholder pack so the apply path is
 * exercised end to end; the real vertical-tuned pack content is a separate
 * issue (part of #455).
 */

export interface IndustryPack {
  /** Stable slug, e.g. "restaurants-food-service". Used in the API path and the ACTION marker. */
  id: string;
  label: string;
  /** Who a pre-PMF startup in this vertical actually sells to. Shown on the pack card AND fed to the strategist. */
  buyerBrief: string;
  /** Proposed icpOneLiner for this buyer — founder edits before it sticks. Never written to config.json by apply. */
  icpOneLiner: string;
  /** trigger name -> config patch, merged over that trigger's STORED config (falling back to its defaultConfig). */
  triggers: Record<string, Record<string, unknown>>;
  /**
   * Founder-voice keys the pack deliberately leaves blank (e.g. `yourEdge`,
   * `yourClaim`) because they have to come from the founder, not a template.
   * Surfaced on the pack card so the founder knows what's left after Apply.
   */
  requires: string[];
}

export const PACKS: IndustryPack[] = [
  {
    id: "devtools-early-adopters",
    label: "Dev Tools — Early Adopters",
    buyerBrief:
      "Pre-PMF dev-tool founders sell to the engineers already active in public dev communities: Show HN readers reacting to launches, and companies whose founding/staff-engineer hiring signals a build-vs-buy decision in flight. Placeholder pack — the full vertical library ships separately.",
    icpOneLiner: "Engineers and technical founders evaluating new developer tooling",
    triggers: {
      // No readiness gate — comes out of Apply already ready. minPoints=1
      // because a quiet Show HN launch (few points) is itself the signal for
      // a founder-tool motion, not traction (see the STRATEGIST NOTE on
      // show-hn's configBrief).
      "show-hn": { minPoints: 1 },
      // Has a readiness gate requiring `yourClaim` (registry.ts hiring-signal
      // spec) — deliberately left unset here (see `requires` below), so this
      // trigger comes out of Apply enabled-but-not-ready. Exercises that path.
      "hiring-signal": {
        roles: ["Founding Engineer", "Staff Engineer", "Head of Engineering"],
      },
    },
    requires: ["yourClaim"],
  },
];

export function getPack(id: string): IndustryPack | null {
  return PACKS.find((p) => p.id === id) ?? null;
}
