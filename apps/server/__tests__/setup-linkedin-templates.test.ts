import { describe, expect, it } from "vitest";
import type { OneShotConfig } from "@oneshot-gtm/core";
import {
  linkedinTemplateWarnings,
  mergeSetupConfig,
  SetupValidationError,
} from "../src/api/setup.ts";

// /setup saves the LinkedIn templates and who writes the copy. The CLI's
// invitesPerDay always survives; empty objects are dropped, never saved.

const CFG = {
  walletMode: "cdp",
  llmProvider: "openrouter",
  llmModel: "model",
  telemetryEnabled: false,
  founderName: "Jane",
  founderEmail: null,
  productOneLiner: "x",
  productDomain: null,
  sendingDomain: null,
  emailProvider: "oneshot",
  emailIdentities: null,
  icpOneLiner: "y",
  founderCredentials: null,
  productPortfolio: null,
  partners: null,
  founderAdmission: null,
  productBrief: null,
  mobileSignature: false,
  slackWebhookUrl: null,
  dailySpendCeilingUsd: null,
  calendarIdentityId: null,
  calendarId: "primary",
} as unknown as OneShotConfig;

const merge = (current: OneShotConfig, body: Parameters<typeof mergeSetupConfig>[1]) =>
  mergeSetupConfig(current, body, current.emailIdentities);

const withLinkedIn = (linkedin: OneShotConfig["linkedin"]): OneShotConfig => ({
  ...CFG,
  linkedin,
});

describe("linkedin.templates on /setup", () => {
  it("saves trimmed text and keeps invitesPerDay", () => {
    const next = merge(withLinkedIn({ invitesPerDay: 12 }), {
      linkedin: { templates: { note: "  Hi {first_name}, saw {evidence}.  " } },
    });
    expect(next.linkedin).toEqual({
      invitesPerDay: 12,
      templates: { note: "Hi {first_name}, saw {evidence}." },
    });
  });

  it("keeps steps the body leaves out, and everything when linkedin is absent", () => {
    const set = withLinkedIn({
      invitesPerDay: 12,
      writer: "model",
      templates: { note: "Hi {first_name}.", friendNote: "Hello {first_name}." },
    });
    expect(merge(set, { linkedin: { templates: { note: "Hey {first_name}." } } }).linkedin).toEqual(
      {
        invitesPerDay: 12,
        writer: "model",
        templates: { note: "Hey {first_name}.", friendNote: "Hello {first_name}." },
      },
    );
    expect(merge(set, { founderName: "Janet" }).linkedin).toEqual(set.linkedin);
    expect("linkedin" in merge(CFG, { founderName: "Janet" })).toBe(false);
  });

  it("a blank step removes it; the last one drops templates, then linkedin itself", () => {
    const set = withLinkedIn({
      templates: { note: "Hi {first_name}.", friendNote: "Hello {first_name}." },
    });
    expect(merge(set, { linkedin: { templates: { note: "  " } } }).linkedin).toEqual({
      templates: { friendNote: "Hello {first_name}." },
    });
    expect(
      "linkedin" in merge(set, { linkedin: { templates: { note: "", friendNote: "" } } }),
    ).toBe(false);
  });

  it("null clears every template and keeps invitesPerDay and writer", () => {
    const set = withLinkedIn({
      invitesPerDay: 12,
      writer: "model",
      templates: { note: "Hi {first_name}." },
    });
    expect(merge(set, { linkedin: { templates: null } }).linkedin).toEqual({
      invitesPerDay: 12,
      writer: "model",
    });
    expect(
      "linkedin" in
        merge(withLinkedIn({ templates: { note: "x" } }), {
          linkedin: { templates: null },
        }),
    ).toBe(false);
  });

  it("refuses an unknown step, an unknown placeholder and one the step can't use", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ greeting: "Hi {first_name}." }, /unknown step greeting/],
      [{ note: "Hi {nickname}." }, /Connection request: unknown placeholder \{nickname\}/],
      [
        { noteFallback: "Hi {first_name}, {offer}." },
        /Connection request, no evidence: \{offer\} can't be used/,
      ],
      [{ note: "x".repeat(601) }, /longer than 600 characters/],
      [{ note: 42 }, /must be text/],
      ["Hi", /must be an object/],
    ];
    for (const [templates, message] of cases)
      expect(
        () => merge(CFG, { linkedin: { templates } as never }),
        JSON.stringify(templates),
      ).toThrow(message);
    expect(() => merge(CFG, { linkedin: null as never })).toThrow(SetupValidationError);
  });
});

describe("linkedin.writer on /setup", () => {
  it("saves template or model, null clears it, and anything else is refused", () => {
    const set = withLinkedIn({ invitesPerDay: 5 });
    expect(merge(set, { linkedin: { writer: "model" } }).linkedin).toEqual({
      invitesPerDay: 5,
      writer: "model",
    });
    const model = withLinkedIn({ invitesPerDay: 5, writer: "model" });
    expect(merge(model, { linkedin: { writer: "template" } }).linkedin?.writer).toBe("template");
    expect(merge(model, { linkedin: { writer: null } }).linkedin).toEqual({ invitesPerDay: 5 });
    expect(() => merge(set, { linkedin: { writer: "llm" as never } })).toThrow(
      /linkedin.writer must be one of template, model/,
    );
  });
});

describe("linkedin template warnings", () => {
  it("warns on a note that can run past 300 characters once filled, not on a short one", () => {
    const long = `Hi {first_name}, saw {evidence}. ${"a".repeat(200)}`;
    const warnings = linkedinTemplateWarnings({
      templates: { note: long, noteFallback: "Hi {first_name}." },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Connection request: up to \d+ characters/);
    expect(warnings[0]).toContain("over its 300-character limit");
    expect(linkedinTemplateWarnings({ templates: { note: "Hi {first_name}." } })).toEqual([]);
    expect(linkedinTemplateWarnings(undefined)).toEqual([]);
    expect(linkedinTemplateWarnings({ templates: null })).toEqual([]);
  });

  it("holds a message step to 400", () => {
    const text = `Hi {first_name}, {offer}. ${"a".repeat(230)}`;
    expect(linkedinTemplateWarnings({ templates: { firstMessage: text } })).toEqual([]);
    expect(
      linkedinTemplateWarnings({ templates: { lastMessage: `${text}${"a".repeat(20)}` } }),
    ).toHaveLength(1);
  });
});
