import { describe, expect, it } from "vitest";
import { lintGrounding } from "../src/_run-play.ts";

// `standardEnrich` serializes safeEnrich's result straight into the prompt's
// DOSSIER block — the failure sentinel included. `prep.enrichmentFailed` was
// already set and already shown in the queue UI, but nothing pushed a flag, and
// `sendDraftedEmail` only holds a draft when `flags` is non-empty. So the draft
// went out with `{"status":"failed","profile":null,"cost":0}` as its dossier.

describe("lintGrounding", () => {
  it("flags a draft whose enrich failed and whose target carries nothing else", () => {
    // The prospect-679 shape: a name, a company string, an empty Luma bio.
    expect(lintGrounding({ attendeeBio: "", role: "Guest" }, { enrichmentFailed: true })).toEqual([
      "ungrounded",
    ]);
  });

  it("stays quiet when the enrich succeeded", () => {
    expect(lintGrounding({ attendeeBio: "" }, {})).toEqual([]);
    expect(lintGrounding({}, { enrichmentFailed: false })).toEqual([]);
  });

  it("stays quiet when the target has its own grounding despite the failure", () => {
    // A failed enrich is survivable when the draft still has something true to
    // say. Flagging these would hold drafts that are perfectly fine.
    expect(lintGrounding({ title: "Co-Founder, CTO" }, { enrichmentFailed: true })).toEqual([]);
    expect(lintGrounding({ attendeeBio: "Founder @ AcmeAI" }, { enrichmentFailed: true })).toEqual(
      [],
    );
  });

  it("does not count a bare event role as grounding", () => {
    // "Guest" says nothing about what the person does — it is why the
    // person-level ICP gate treats a bare event role as `unclear`.
    expect(lintGrounding({ role: "Host", title: "" }, { enrichmentFailed: true })).toEqual([
      "ungrounded",
    ]);
  });

  it("tolerates a target that is not an object", () => {
    expect(lintGrounding(null, { enrichmentFailed: true })).toEqual(["ungrounded"]);
  });
});
