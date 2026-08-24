import { describe, expect, it } from "vitest";
import { capGroupKey } from "../src/send-routing.ts";
import type { EmailIdentity } from "../src/types.ts";

// Smartlead cap-grouping: per-account budgets (Smartlead's own
// message_per_day is per-mailbox), so each identity is its own group even
// when two mailboxes share a From-domain.

function sl(id: string, address: string): EmailIdentity {
  return { id, provider: "smartlead", address, maxPerDay: 50, warmup: null };
}

describe("capGroupKey for smartlead", () => {
  it("keys each smartlead identity by its own id", () => {
    const a = sl("smartlead:a@acme.com", "a@acme.com");
    const b = sl("smartlead:b@acme.com", "b@acme.com");
    expect(capGroupKey(a)).toBe("id:smartlead:a@acme.com");
    expect(capGroupKey(b)).toBe("id:smartlead:b@acme.com");
    expect(capGroupKey(a)).not.toBe(capGroupKey(b)); // same domain, separate budgets
  });
});
