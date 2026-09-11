import { describe, expect, it } from "vitest";
import {
  hasDossierSignal,
  hasPersonSignal,
  mergePersonDossier,
  mergeProductDossier,
} from "../src/dossier.ts";

// The gate that decides whether a dossier is worth writing to
// prospects.dossier_json. It is load-bearing: _reply-research.ts treats any
// non-empty value as a free Tier-1 hit and skips paid research, so a
// contentless dossier is worse than no dossier at all.

describe("hasDossierSignal — real payloads that must be REJECTED", () => {
  it("rejects a failed enrich, which still serializes to a non-empty object", () => {
    // What standardEnrich stores when safeEnrich fails. A bare .trim() check
    // passes this, stores it, and suppresses the reply drafter's paid tiers.
    expect(hasDossierSignal(JSON.stringify({ status: "failed", profile: null, cost: 0 }))).toBe(
      false,
    );
    expect(hasDossierSignal({ status: "failed", profile: null, cost: 0 })).toBe(false);
  });

  it("rejects a person lookup that found nobody — full key set, empty values", () => {
    expect(
      hasDossierSignal({
        email: "a@b.c",
        title: null,
        company: null,
        summary: "",
        experience: [],
        education: [],
        skills: [],
        enrichment: { title: null, company: null, summary: "", experience: [] },
      }),
    ).toBe(false);
  });

  it("rejects the role-based-mailbox placeholder — a fact about the inbox", () => {
    expect(hasDossierSignal({ summary: "hi@niklasfrick.com is a role based email address." })).toBe(
      false,
    );
    expect(
      hasDossierSignal({ enrichment: { summary: "hi@avi.mn is a role based email address." } }),
    ).toBe(false);
  });

  it("rejects a location-only dossier — grounds nothing, still blocks Tier-2", () => {
    expect(hasDossierSignal({ location: "United States", summary: "" })).toBe(false);
  });

  it("rejects blank and missing values", () => {
    expect(hasDossierSignal(null)).toBe(false);
    expect(hasDossierSignal(undefined)).toBe(false);
    expect(hasDossierSignal("")).toBe(false);
    expect(hasDossierSignal("   ")).toBe(false);
    expect(hasDossierSignal({})).toBe(false);
    expect(hasDossierSignal("{}")).toBe(false);
    expect(hasDossierSignal(42)).toBe(false);
  });

  it("rejects a failure even when it carries other keys", () => {
    expect(hasDossierSignal({ status: "FAILED", title: "CTO" })).toBe(false);
  });

  it("rejects product source URLs without factual excerpts", () => {
    expect(hasDossierSignal({ product: { sources: [{ url: "https://acme.dev" }] } })).toBe(false);
  });
});

describe("hasDossierSignal — payloads that must be ACCEPTED", () => {
  it("accepts real content, flat or nested", () => {
    expect(hasDossierSignal({ title: "Graduate Teaching Assistant" })).toBe(true);
    expect(hasDossierSignal({ enrichment: { company: "Acme" } })).toBe(true);
    expect(hasDossierSignal({ profile: { title: "Staff Engineer" } })).toBe(true);
    expect(hasDossierSignal({ result: { enrichment: { bio: "builds agent infra" } } })).toBe(true);
    expect(
      hasDossierSignal({
        product: { sources: [{ url: "https://acme.dev", excerpt: "Agent platform" }] },
      }),
    ).toBe(true);
  });

  it("accepts non-empty list fields and articles", () => {
    expect(hasDossierSignal({ experience: [{ title: "CTO" }] })).toBe(true);
    expect(hasDossierSignal({ skills: ["rust"] })).toBe(true);
    expect(hasDossierSignal({ articles: [{ title: "x" }] })).toBe(true);
  });

  it("accepts a successful enrich envelope", () => {
    expect(
      hasDossierSignal(
        JSON.stringify({ status: "completed", profile: { title: "Founder" }, cost: 0.005 }),
      ),
    ).toBe(true);
  });

  it("accepts prose a play assembled — that is genuine context, not a payload", () => {
    expect(hasDossierSignal("Founder at Acme; ships agent infra.")).toBe(true);
  });

  it("keeps a TRUNCATED payload rather than discarding research already paid for", () => {
    // Dossiers are sliced to 6000 chars, so a stored payload may not re-parse.
    const truncated = `{"status":"completed","profile":{"title":"Head of Platform","comp`;
    expect(hasDossierSignal(truncated)).toBe(true);
  });
});

describe("mergeProductDossier", () => {
  it("preserves legacy person context and adds sourced product context", () => {
    const merged = JSON.parse(
      mergeProductDossier(JSON.stringify({ title: "Founder", company: "Acme" }), {
        version: 1,
        status: "complete",
        researchedAt: "2026-09-02T00:00:00.000Z",
        subject: { company: "Acme" },
        sources: [{ url: "https://acme.dev", kind: "website", excerpt: "Agent platform" }],
      }),
    ) as Record<string, Record<string, unknown>>;
    expect(merged["person"]?.["title"]).toBe("Founder");
    expect(merged["product"]?.["status"]).toBe("complete");
    expect(hasDossierSignal(merged)).toBe(true);
  });
});

// The dossier that shipped an ungrounded email to prospect 679. Its product
// half read a Luma user profile for someone who hosts no events: the fetch
// succeeded, the excerpt is a few hundred characters, and every one of them is
// page chrome. It counted as signal, so the paid research tiers stayed
// suppressed and the person half stayed null forever.
const LUMA_EMPTY_PROFILE = {
  person: null,
  product: {
    version: 1,
    status: "partial",
    researchedAt: "2026-09-01T22:51:05.891Z",
    subject: { name: "Raunaq Bose", company: "Taxheaven" },
    sources: [
      {
        url: "https://luma.com/user/rnq",
        kind: "website",
        excerpt:
          "# Raunaq Bose\n\n@rnq\n\nJoined March 2026\n\n0Hosted\n\n29Attended\n\n" +
          "### Nothing Here, Yet\n\nRaunaq Bose has no public events at this time.",
      },
    ],
  },
};

describe("hasDossierSignal — an excerpt must be informative, not merely non-empty", () => {
  it("rejects a profile page whose body is its own 'nothing here' message", () => {
    expect(hasDossierSignal(LUMA_EMPTY_PROFILE)).toBe(false);
  });

  it("still accepts a product source that says something", () => {
    expect(
      hasDossierSignal({
        sources: [
          {
            url: "https://www.xevall.com/",
            kind: "website",
            excerpt: "The independent evals and self-improvement layer for human-AI interaction.",
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("hasPersonSignal — is there PERSON research, specifically", () => {
  it("is false for the wrapper research-products writes over an unresearched row", () => {
    // The whole bug in one assertion: 531 of 684 prospects were in this state,
    // and the old backlog query (dossier_json IS NULL OR TRIM = '') read every
    // one of them as done.
    expect(hasPersonSignal(JSON.stringify(LUMA_EMPTY_PROFILE))).toBe(false);
  });

  it("is false for a null/empty column", () => {
    expect(hasPersonSignal(null)).toBe(false);
    expect(hasPersonSignal("   ")).toBe(false);
  });

  it("is true once the person half carries research", () => {
    expect(
      hasPersonSignal(
        JSON.stringify({
          person: { title: "Co-Founder & CTO", company: "xevall", summary: "Building evals." },
          product: LUMA_EMPTY_PROFILE.product,
        }),
      ),
    ).toBe(true);
  });

  it("is false when the person half is a failed-enrich envelope", () => {
    expect(
      hasPersonSignal(
        JSON.stringify({ person: { status: "failed", profile: null }, product: null }),
      ),
    ).toBe(false);
  });

  it("reads a pre-wrapper row, where the person payload IS the whole column", () => {
    expect(hasPersonSignal(JSON.stringify({ title: "CTO", company: "Acme" }))).toBe(true);
  });
});

describe("mergePersonDossier — must not clobber the product half", () => {
  it("keeps existing product research when writing the person half", () => {
    const merged = mergePersonDossier(JSON.stringify(LUMA_EMPTY_PROFILE), {
      title: "Co-Founder & CTO",
      company: "xevall",
    });
    const parsed = JSON.parse(merged) as { person: unknown; product: { subject: unknown } };
    expect(parsed.product).toEqual(LUMA_EMPTY_PROFILE.product);
    expect(parsed.person).toEqual({ title: "Co-Founder & CTO", company: "xevall" });
  });

  it("round-trips with mergeProductDossier without either half losing the other", () => {
    const withPerson = mergePersonDossier(null, { title: "CTO" });
    const withBoth = mergeProductDossier(withPerson, {
      version: 1,
      status: "complete",
      researchedAt: "2026-09-04T00:00:00.000Z",
      subject: { company: "xevall" },
      sources: [],
    });
    const parsed = JSON.parse(withBoth) as {
      person: { title: string };
      product: { status: string };
    };
    expect(parsed.person.title).toBe("CTO");
    expect(parsed.product.status).toBe("complete");
  });

  it("produces valid JSON from a null column", () => {
    expect(() => JSON.parse(mergePersonDossier(null, { title: "CTO" }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Person research: the record every consumer reads (current role from the
// LinkedIn history), and the merge that puts it in the person half.
// ---------------------------------------------------------------------------
import {
  boundPersonResearch,
  companyRecordFromResearch,
  isPersonResearchDossier,
  mergePersonResearchDossier,
  personRecordFromResearch,
  readPersonHalf,
  renderCompanyFacts,
  renderCurrentRole,
  renderFormerRoles,
  type PersonResearchDossier,
} from "../src/dossier.ts";

const julia: PersonResearchDossier = {
  version: 1,
  status: "complete",
  researchedAt: "2026-09-11T20:00:00.000Z",
  seed: { url: "https://linkedin.com/in/julia-zabrodska-akinci-cv", name: "Julia Zabrodska" },
  currentRole: { title: "Founder & Product Owner", company: "WildMuse.App", since: "Mar 2026" },
  organizations: [
    {
      name: "WildMuse.App",
      title: "Founder & Product Owner",
      startDate: "Mar 2026",
      current: true,
    },
    {
      name: "L'ETO Group",
      title: "Head of Product and Business Development Manager",
      startDate: "Nov 2024",
      endDate: "Oct 2025",
      current: false,
    },
    {
      name: "Julia's Consultancy",
      title: "Business Consultant",
      startDate: "Oct 2022",
      endDate: "Nov 2024",
      current: false,
    },
  ],
  bio: "Solo-built consumer wellness app from 0 to first revenue.",
  location: "London",
  workEmail: "julia@wildmuse.app",
  company: {
    name: "WildMuse.App",
    industry: "Software",
    size: "1-10",
    founded: 2026,
    description: "Consumer wellness app.",
  },
  costUsd: 0.055,
  cached: false,
};

describe("person research record", () => {
  it("renders the current role, company facts and former roles as short lines", () => {
    expect(renderCurrentRole(julia)).toBe("Founder & Product Owner at WildMuse.App since Mar 2026");
    expect(renderCompanyFacts(julia.company)).toBe(
      "WildMuse.App · Software · 1-10 employees · founded 2026 — Consumer wellness app.",
    );
    expect(renderFormerRoles(julia)).toBe(
      "Head of Product and Business Development Manager at L'ETO Group (Nov 2024–Oct 2025); Business Consultant at Julia's Consultancy (Oct 2022–Nov 2024)",
    );
  });

  it("builds the person record the reject describer and the signal gate read", () => {
    const record = personRecordFromResearch(julia);
    expect(record["title"]).toBe("Founder & Product Owner");
    expect(record["company"]).toBe("WildMuse.App");
    expect(record["summary"]).toBe(julia.bio);
    expect(record["organizations"]).toEqual([
      {
        name: "WildMuse.App",
        title: "Founder & Product Owner",
        startDate: "Mar 2026",
        is_current: true,
      },
      expect.objectContaining({ name: "L'ETO Group", is_current: false }),
      expect.objectContaining({ name: "Julia's Consultancy", is_current: false }),
    ]);
    expect(hasDossierSignal(record)).toBe(true);
    expect(companyRecordFromResearch(julia)).toEqual({
      name: "WildMuse.App",
      industry: "Software",
      size: "1-10",
      founded: 2026,
      description: "Consumer wellness app.",
    });
    expect(companyRecordFromResearch({ ...julia, company: undefined })).toBeNull();
  });

  it("merges into the person half, keeps the product half and a prior enrich record, drops a failed sentinel", () => {
    const product = { version: 1, status: "partial", researchedAt: "x", subject: {}, sources: [] };
    const withEnrich = JSON.stringify({
      person: {
        status: "completed",
        profile: { title: "| Curious Explorer", company: "L'eto Group" },
      },
      product,
    });
    const merged = JSON.parse(mergePersonResearchDossier(withEnrich, julia)) as Record<
      string,
      unknown
    >;
    expect(merged["product"]).toEqual(product);
    const person = merged["person"] as Record<string, unknown>;
    expect(person["title"]).toBe("Founder & Product Owner");
    expect(person["source"]).toBe("deepResearchPerson");
    expect((person["enrichment"] as Record<string, unknown>)["status"]).toBe("completed");

    const failed = JSON.stringify({
      person: { status: "failed", profile: null, cost: 0 },
      product,
    });
    const merged2 = JSON.parse(mergePersonResearchDossier(failed, julia)) as Record<
      string,
      unknown
    >;
    expect((merged2["person"] as Record<string, unknown>)["enrichment"]).toBeUndefined();
    expect(merged2["product"]).toEqual(product);

    // A second research run replaces the earlier researched record rather than nesting it.
    const again = JSON.parse(mergePersonResearchDossier(JSON.stringify(merged), julia)) as Record<
      string,
      unknown
    >;
    expect((again["person"] as Record<string, unknown>)["enrichment"]).toBeUndefined();
    expect(readPersonHalf(JSON.stringify(again))).toEqual(again["person"]);
  });

  it("bounds the record at 4,000 chars without losing the current role", () => {
    const big: PersonResearchDossier = {
      ...julia,
      bio: "x".repeat(3000),
      company: { ...julia.company, description: "y".repeat(400) },
      organizations: [
        julia.organizations[0]!,
        ...Array.from({ length: 7 }, (_, i) => ({
          name: `Old Co ${i} ${"z".repeat(300)}`,
          current: false,
        })),
      ],
    };
    const bounded = boundPersonResearch(big);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(4000);
    expect(bounded.currentRole).toEqual(julia.currentRole);
    expect(bounded.organizations[0]).toEqual(julia.organizations[0]);
    expect(isPersonResearchDossier(bounded)).toBe(true);
    expect(isPersonResearchDossier({ version: 2 })).toBe(false);
  });
});
