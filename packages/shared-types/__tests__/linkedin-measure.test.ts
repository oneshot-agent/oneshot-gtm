import { describe, expect, it } from "vitest";
import { type LinkedInFunnel, linkedInFunnelHasActivity } from "../src/index";

// The funnel is shown once there is anything in it: an invite, or a known
// connection reached without one. All zeros is the empty view.
const empty: LinkedInFunnel = {
  invitesSent: 0,
  pending: 0,
  withdrawn: { total: 0, timeout: 0, manual: 0, unknown: 0 },
  accepted: {
    total: 0,
    viaInvitation: 0,
    viaConversation: 0,
    medianDaysToAccept: null,
    daysKnown: 0,
    rate: null,
  },
  alreadyConnected: 0,
  firstMessageSent: 0,
  repliedToFirstMessage: { count: 0, of: 0, rate: null },
  repliedAtAnyPoint: { count: 0, of: 0, rate: null },
  repliesMerged: 0,
};

describe("linkedInFunnelHasActivity", () => {
  it("is false when every count is zero", () => {
    expect(linkedInFunnelHasActivity(empty)).toBe(false);
  });

  it("is true for an invite, a known connection, or a first message", () => {
    expect(linkedInFunnelHasActivity({ ...empty, invitesSent: 1 })).toBe(true);
    expect(linkedInFunnelHasActivity({ ...empty, alreadyConnected: 1 })).toBe(true);
    expect(linkedInFunnelHasActivity({ ...empty, firstMessageSent: 1 })).toBe(true);
  });
});
