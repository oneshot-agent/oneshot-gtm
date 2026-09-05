import { describe, expect, it } from "vitest";
import { CDP_KEYS, walletKeysInUse } from "../src/components/setup/constants.ts";

// Mirrors core's initAgent precedence: AGENT_PRIVATE_KEY wins whenever it is
// set, otherwise the CDP trio. The saved walletMode plays no part — a badge
// keyed off it said "in use" next to empty CDP fields on an install that runs
// on a private key.
describe("walletKeysInUse", () => {
  it("prefers the private key when it is set, wherever it comes from", () => {
    expect(walletKeysInUse({ AGENT_PRIVATE_KEY: "file" })).toEqual(["AGENT_PRIVATE_KEY"]);
    expect(walletKeysInUse({ AGENT_PRIVATE_KEY: "env", CDP_API_KEY_ID: "file" })).toEqual([
      "AGENT_PRIVATE_KEY",
    ]);
  });

  it("falls back to the CDP trio otherwise, even when none of them is set yet", () => {
    expect(walletKeysInUse({ CDP_API_KEY_ID: "file" })).toEqual(CDP_KEYS);
    expect(walletKeysInUse({})).toEqual(CDP_KEYS);
    expect(walletKeysInUse({ AGENT_PRIVATE_KEY: null })).toEqual(CDP_KEYS);
  });
});
