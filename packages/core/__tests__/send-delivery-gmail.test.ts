import { describe, expect, it } from "vitest";
import {
  PermanentDeliveryError,
  TransientDeliveryError,
  classifyGmailReadError,
} from "../src/send-delivery.ts";

// A revoked Gmail token must not be retried every sweep (it would hold its
// sends in the batch until they age out); a quota or network blip must be.

describe("classifyGmailReadError", () => {
  it.each([
    "Gmail credentials missing (refresh token) — run: bun run cli -- gmail auth",
    "Gmail auth expired or revoked for gmail:jn@x.example — run: bun run cli -- gmail auth",
    "Gmail auth rejected (401) — run: bun run cli -- gmail auth",
    "Gmail API failed (403): PERMISSION_DENIED insufficient scope [/messages]",
  ])("lost authorization is permanent: %s", (msg) => {
    expect(classifyGmailReadError(new Error(msg))).toBeInstanceOf(PermanentDeliveryError);
  });

  it.each([
    "Gmail API failed (429): RESOURCE_EXHAUSTED quota [/messages]",
    "Gmail API failed (503): backend error [/messages]",
    "fetch failed",
  ])("quota and network errors stay transient: %s", (msg) => {
    expect(classifyGmailReadError(new Error(msg))).toBeInstanceOf(TransientDeliveryError);
  });

  it("keeps the original message", () => {
    expect(classifyGmailReadError(new Error("fetch failed")).message).toBe("fetch failed");
  });
});
