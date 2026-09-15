import { describe, expect, it } from "vitest";
import type { DoctorCheck } from "@oneshot-gtm/shared-types";
import { formatUsd, walletPill } from "../src/lib/walletPill.ts";

const env: DoctorCheck = {
  name: "wallet env",
  group: "spend",
  severity: "ok",
  message: "AGENT_PRIVATE_KEY set (file)",
};
const balance = (over: Partial<DoctorCheck>): DoctorCheck => ({
  name: "wallet balance",
  group: "spend",
  severity: "ok",
  message: "$26.89 USDC · checked 3h ago",
  balanceUsd: 26.89,
  balanceCheckedAt: "2026-09-15T18:00:00.000Z",
  ...over,
});

describe("walletPill", () => {
  it("shows the balance, not the env source, when the doctor read one", () => {
    const pill = walletPill([env, balance({})]);
    expect(pill).toMatchObject({ value: "$26.89", tone: "receipt", hasBalance: true });
    expect(pill.title).toContain("checked 3h ago");
    expect(pill.title).toContain("refreshes daily");
  });

  it("goes red at zero and amber when low, carrying the doctor's hint", () => {
    const empty = walletPill([
      env,
      balance({
        severity: "fail",
        balanceUsd: 0,
        message: "$0.00 USDC · checked just now",
        hint: "top up",
      }),
    ]);
    expect(empty).toMatchObject({ value: "$0.00", tone: "blocked" });
    expect(empty.title).toContain("top up");
    expect(walletPill([balance({ severity: "warn", balanceUsd: 3.2 })])).toMatchObject({
      value: "$3.20",
      tone: "spend",
    });
  });

  it("falls back to the env pill when no balance check exists, and to a dash with nothing", () => {
    expect(walletPill([env])).toMatchObject({ value: "pk", tone: "receipt", hasBalance: false });
    expect(walletPill([{ ...env, message: "CDP wallet set (file)" }])).toMatchObject({
      value: "cdp",
    });
    expect(
      walletPill([{ ...env, severity: "fail", message: "no wallet credentials" }]),
    ).toMatchObject({
      value: "fail",
      tone: "blocked",
    });
    expect(walletPill([])).toMatchObject({ value: "—", tone: "neutral" });
    expect(walletPill([], true)).toMatchObject({ value: "…" });
  });

  it("shows the severity word when the balance could not be parsed", () => {
    const pill = walletPill([
      balance({ severity: "warn", balanceUsd: undefined, message: "could not fetch: timeout" }),
    ]);
    expect(pill).toMatchObject({ value: "warn", tone: "spend", hasBalance: true });
  });

  it("formats cents under $100 and whole dollars above", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(26.894)).toBe("$26.89");
    expect(formatUsd(1234.5)).toBe("$1235");
  });
});
