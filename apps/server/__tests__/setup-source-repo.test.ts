import { describe, expect, it } from "vitest";
import type { OneShotConfig } from "@oneshot-gtm/core";
import { mergeSetupConfig, SetupValidationError } from "../src/api/setup.ts";

// /setup saves the source repo read for answers from your code, and how much
// those answers may say. Absent stays absent; null or blank turns it off.

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
  productBrief: "Brief.",
  mobileSignature: false,
  slackWebhookUrl: null,
  dailySpendCeilingUsd: null,
  calendarIdentityId: null,
  calendarId: "primary",
} as unknown as OneShotConfig;

const merge = (current: OneShotConfig, body: Parameters<typeof mergeSetupConfig>[1]) =>
  mergeSetupConfig(current, body, current.emailIdentities);

describe("sourceRepo on /setup", () => {
  it("saves a GitHub URL with a ref, trimmed", () => {
    const next = merge(CFG, {
      sourceRepo: { url: " https://github.com/acme/widget ", ref: " main " },
    });
    expect(next.sourceRepo).toEqual({ url: "https://github.com/acme/widget", ref: "main" });
    expect(next.productBrief).toBe("Brief.");
  });

  it("saves a local path without a ref (the default branch)", () => {
    const next = merge(CFG, { sourceRepo: { path: "/home/me/code/widget", ref: "" } });
    expect(next.sourceRepo).toEqual({ path: "/home/me/code/widget" });
  });

  it("keeps it when the body does not touch it, and leaves it absent when never set", () => {
    const set = { ...CFG, sourceRepo: { url: "https://github.com/acme/widget" } };
    expect(merge(set, { founderName: "Janet" }).sourceRepo).toEqual(set.sourceRepo);
    expect("sourceRepo" in merge(CFG, { founderName: "Janet" })).toBe(false);
  });

  it("turns off on null or when both url and path are blank", () => {
    const set = { ...CFG, sourceRepo: { url: "https://github.com/acme/widget", ref: "main" } };
    expect("sourceRepo" in merge(set, { sourceRepo: null })).toBe(false);
    expect("sourceRepo" in merge(set, { sourceRepo: { url: " ", path: "", ref: "main" } })).toBe(
      false,
    );
  });

  it("refuses a URL that is not a GitHub repo, a relative path, or a ref with spaces", () => {
    for (const sourceRepo of [
      { url: "https://gitlab.com/acme/widget" },
      { url: "https://github.com/acme" },
      { url: "http://github.com/acme/widget" },
      { url: "not a url" },
      { path: "code/widget" },
      { path: "/abs", ref: "main branch" },
      { path: "/abs", ref: "--upload-pack=x" },
    ])
      expect(() => merge(CFG, { sourceRepo }), JSON.stringify(sourceRepo)).toThrow(
        SetupValidationError,
      );
  });
});

describe("codeAnswerDisclosure on /setup", () => {
  it("saves trimmed text, keeps it when untouched, clears on blank", () => {
    const next = merge(CFG, { codeAnswerDisclosure: "  What a caller sees only.  " });
    expect(next.codeAnswerDisclosure).toBe("What a caller sees only.");
    expect(merge(next, { founderName: "Janet" }).codeAnswerDisclosure).toBe(
      "What a caller sees only.",
    );
    expect("codeAnswerDisclosure" in merge(next, { codeAnswerDisclosure: "" })).toBe(false);
    expect("codeAnswerDisclosure" in merge(CFG, {})).toBe(false);
  });

  it("refuses runaway text", () => {
    expect(() => merge(CFG, { codeAnswerDisclosure: "x".repeat(2001) })).toThrow(
      SetupValidationError,
    );
  });
});
