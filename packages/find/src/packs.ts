/**
 * Industry packs: a working starting config for a founder's vertical, handed
 * over in one shot instead of the strategist proposing one `apply-config`
 * marker per trigger (`packages/prompts/strategist-trigger.md`: "ONE marker
 * per message"). A pack bundles config patches for several triggers at once
 * plus the buyer framing behind them — `TriggerSpec.defaultConfig` already
 * carries generic per-trigger defaults; a pack is a curated OVERLAY on top,
 * anchored in one vertical.
 *
 * See #458 for the mechanism (registry + apply route + placeholder pack) and
 * #464 for this file's real content: seven main-street-and-beyond verticals,
 * each wired to whichever of `local-business` (#457), `local-registry`
 * (#459/#460) or `gov-solicitation`/`civic-agenda` (#461) actually covers
 * that buyer population.
 *
 * WEIGHTING (per #464's card): the coverage spike #456 ran against three
 * verticals with `peopleSearch` (Austin, TX, 50/vertical, best_work_email
 * hit rate) measured the OPPOSITE of the card's stated hypothesis —
 * restaurants 80%, home-services (plumbers) 70%, dental 64% — so
 * `restaurants-food-service` below leans PRIMARILY on `local-business`
 * (best-covered of the three, not worst as hypothesized), while
 * `healthcare-practices` still leans on `local-registry`'s NPPES adapter
 * (dental's B2B coverage was the weakest measured, confirming that half of
 * the original hypothesis). `auto-services`, `professional-services-smb`,
 * `trucking-freight` and `civic-gov` were not part of the spike — those
 * follow the card's original reasoning unchanged.
 *
 * Every pack's `requires` lists only founder-voice keys (`yourEdge`) and
 * deliberately omits them from every trigger patch — those words describe
 * the founder's OWN product, and a pack that guessed at them would produce
 * generic email, the exact failure mode this epic exists to avoid. A trigger
 * a pack touches therefore comes out of Apply enabled but NOT ready until
 * the founder fills `yourEdge` in (via the strategist's `apply-config` or
 * `/queue`'s trigger card) — the intended end state, not a bug.
 */

export interface IndustryPack {
  /** Stable slug, e.g. "restaurants-food-service". Used in the API path and the ACTION marker. */
  id: string;
  label: string;
  /**
   * One line of plain buyer language for the picker — who this sells to, no
   * provenance. `buyerBrief` carries the reasoning and reads like the
   * engineering note it is ("the #456 coverage spike measured `peopleSearch`
   * at 80% best_work_email hit rate"), which is the right thing to feed the
   * strategist and the wrong thing to put in front of a founder choosing a
   * vertical. Optional: a pack without one falls back to a truncated
   * `buyerBrief`, so adding a pack never breaks the picker.
   */
  summary?: string;
  /** Who a pre-PMF startup in this vertical actually sells to, and WHY these channels. Fed to the strategist; shown behind a disclosure in the picker. */
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
    summary: "Engineers reacting to launches, and teams hiring for a build-vs-buy decision.",
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
  {
    id: "restaurants-food-service",
    label: "Restaurants & Food Service",
    summary: "Owners and GMs at independent restaurants, franchisees, and ghost kitchens.",
    buyerBrief:
      "Owner / GM / franchisee at independent restaurants, multi-unit franchisees, and ghost kitchens. The coverage spike (#456) measured `peopleSearch` at 80% best_work_email hit rate for independent restaurants in Austin, TX — the BEST of the three verticals tested, the opposite of the working hypothesis that single-location restaurants would be the weakest B2B-database population. `local-business` is therefore the primary channel here; `local-registry`'s city license/inspection data still adds the earliest-possible new-opening signal (a fresh Health Dept permit predates most restaurants having any web presence at all), so it stays on as a secondary channel.",
    icpOneLiner: "Owners and GMs of independent restaurants, franchisees, and ghost kitchens",
    triggers: {
      "local-business": {
        jobTitles: ["Owner", "General Manager", "Managing Partner", "Franchisee"],
        industries: [
          "Restaurants",
          "Food Service",
          "Ghost Kitchens",
          "Quick Service Restaurants",
          "Catering",
        ],
      },
      "local-registry": {
        portals: [
          { host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC business licenses" },
        ],
        licenseTypes: ["Restaurant", "Food Service Establishment", "Food Vendor"],
        inspectionPortals: [
          {
            host: "data.cityofnewyork.us",
            dataset: "43nn-pn8j",
            label: "NYC restaurant inspections",
          },
        ],
      },
    },
    requires: ["yourEdge"],
  },
  {
    id: "home-services-trades",
    label: "Home Services & Trades",
    summary:
      "Owner-operators and office managers at HVAC, plumbing, electrical, and roofing firms.",
    buyerBrief:
      "Owner-operator / office manager at HVAC, plumbing, electrical, roofing, landscaping and pest-control businesses. Both channels lean on here: state contractor licence boards (`local-registry`) reach the long tail of one-truck operators who never show up in a B2B people database, while `local-business` reaches the 20+ staff shops with an office manager and an actual buying process. The spike's home-services proxy (two-truck plumbers) measured 70% `peopleSearch` coverage — solid but not restaurant-tier — consistent with keeping both channels rather than picking one.",
    icpOneLiner: "Owner-operators and office managers at home-service and trade businesses",
    triggers: {
      "local-business": {
        jobTitles: ["Owner", "Office Manager", "Operations Manager"],
        industries: [
          "HVAC Contractors",
          "Plumbing Contractors",
          "Electrical Contractors",
          "Roofing Contractors",
          "Landscaping Companies",
          "Pest Control Companies",
        ],
        employeeRange: "11-50",
      },
      "local-registry": {
        portals: [
          {
            host: "data.wa.gov",
            dataset: "m8qx-ubtq",
            label: "WA L&I contractor licenses",
          },
        ],
        licenseTypes: ["HVAC", "Plumbing", "Electrical", "Roofing", "Landscaping", "Pest Control"],
      },
    },
    requires: ["yourEdge"],
  },
  {
    id: "healthcare-practices",
    label: "Healthcare Practices",
    summary: "Practice owners and office managers at dental, optometry, and small medical clinics.",
    buyerBrief:
      "Practice owner / office manager at dental, veterinary, optometry, chiropractic and small primary-care practices. `local-registry`'s NPPES adapter is the most completely covered vertical of the seven — 9M+ providers, free, weekly refresh, filterable by taxonomy — and the coverage spike (#456) measured dental practices at only 64% `peopleSearch` hit rate, the WORST of the three tested verticals, confirming a B2B people database is the wrong primary channel here. `local-business` is deliberately left off this pack.",
    icpOneLiner: "Owners and office managers at dental, veterinary, and small medical practices",
    triggers: {
      "local-registry": {
        taxonomies: ["Dentist", "Veterinarian", "Optometrist", "Chiropractor", "Family Medicine"],
        states: ["NY", "CA", "TX", "FL", "IL"],
      },
    },
    requires: ["yourEdge"],
  },
  {
    id: "auto-services",
    label: "Auto Services",
    summary:
      "Owners and service managers at independent repair shops, tyre, and collision centres.",
    buyerBrief:
      "Shop owner / service manager at independent auto-repair shops, tire shops and body shops. Not part of the #456 coverage spike, so this follows the card's original reasoning unchanged: business licences filtered to NAICS 8111 (automotive repair and maintenance) are the primary channel — an independent single-bay shop is exactly the kind of business a B2B people database under-indexes on.",
    icpOneLiner: "Owners and service managers at independent auto-repair, tire, and body shops",
    triggers: {
      "local-registry": {
        portals: [
          { host: "data.cityofnewyork.us", dataset: "w7w3-xahh", label: "NYC business licenses" },
        ],
        naics: ["8111"],
        licenseTypes: ["Auto Repair", "Tire Dealer", "Body Shop", "Automotive Repair Shop"],
      },
    },
    requires: ["yourEdge"],
  },
  {
    id: "professional-services-smb",
    label: "Professional Services (SMB)",
    summary: "Managing partners at small law, accounting, bookkeeping, and insurance firms.",
    buyerBrief:
      "Managing partner / principal at small law firms, bookkeeping practices, insurance agencies and property managers. Not part of the #456 coverage spike. These are well covered in B2B data (partners and principals at small professional firms are exactly the population `peopleSearch`/`companySearch` index well), so `local-business` is the primary — and only — channel; `local-registry`'s public-registry sources exist for businesses invisible to B2B databases, which does not describe this vertical.",
    icpOneLiner: "Managing partners and principals at small law, accounting, and insurance firms",
    triggers: {
      "local-business": {
        jobTitles: ["Managing Partner", "Principal", "Owner"],
        industries: [
          "Law Firms",
          "Bookkeeping Services",
          "Insurance Agencies",
          "Property Management Companies",
        ],
        employeeRange: "1-10",
      },
    },
    requires: ["yourEdge"],
  },
  {
    id: "trucking-freight",
    label: "Trucking & Freight",
    summary: "Owners and dispatch managers at small carriers, brokerages, and 3PLs.",
    buyerBrief:
      "Owner / VP Ops / dispatch manager at small carriers, brokerages, and 3PLs. Not part of the #456 coverage spike. `local-registry`'s FMCSA adapter carries a published on-file email for every active entity, so there is near-zero cost per candidate — no findEmail/verifyEmail spend at all — and the 10-100 power-unit fleet-size band is the segment that actually buys software (large fleets build in-house, one-truck owner-operators rarely buy).",
    icpOneLiner: "Owners and operations leads at small trucking carriers, brokerages, and 3PLs",
    triggers: {
      "local-registry": {
        entityTypes: ["carrier", "broker", "freight-forwarder"],
        minPowerUnits: 10,
        maxPowerUnits: 100,
      },
    },
    requires: ["yourEdge"],
  },
  {
    id: "civic-gov",
    label: "Civic & Government",
    summary: "City managers, department heads, and procurement officers at local government.",
    buyerBrief:
      "City manager, county administrator, department head, or procurement officer at a municipal or county government. Not part of the #456 coverage spike (no B2B people-database channel applies to public-sector buyers at all). `gov-solicitation` catches federal Sources Sought / Presolicitation notices by NAICS while a requirement is still being written — the one window a pre-PMF startup with no past-performance record can shape it — and `civic-agenda` catches city/county council agenda items mentioning relevant technology before any budget commitment is public. Both pitch the notice's or meeting body's own published contact, so neither spends on findEmail/verifyEmail.",
    icpOneLiner:
      "City managers, department heads, and procurement officers evaluating new software",
    triggers: {
      "gov-solicitation": {
        naics: ["541511", "541512", "541990"],
        noticeTypes: ["r", "p"],
      },
      "civic-agenda": {
        cities: ["New York", "Chicago", "Philadelphia", "Oakland", "San Francisco"],
        keywords: ["software", "technology", "automation", "digital services", "permitting"],
      },
    },
    requires: ["yourEdge"],
  },
];

export function getPack(id: string): IndustryPack | null {
  return PACKS.find((p) => p.id === id) ?? null;
}
