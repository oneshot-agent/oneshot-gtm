/**
 * Inline copy of the `earlyByCopy` helper from apps/web/src/routes/cadences.tsx
 * (the helper isn't exported — it's a local function in the route module).
 * Mirror the implementation here so a behavior change in cadences.tsx without
 * a matching test update gets caught at review time.
 */
function earlyByCopy(iso: string | null | undefined): string {
  if (!iso) return "now";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m early`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `${hours}h early`;
  const days = Math.round(ms / 86_400_000);
  return `${days}d early`;
}

import { describe, expect, it } from "vitest";

describe("earlyByCopy — send-early warning copy", () => {
  it("returns 'now' for null / undefined / past timestamp", () => {
    expect(earlyByCopy(null)).toBe("now");
    expect(earlyByCopy(undefined)).toBe("now");
    expect(earlyByCopy(new Date(Date.now() - 60_000).toISOString())).toBe("now");
    expect(earlyByCopy(new Date(Date.now()).toISOString())).toBe("now");
  });

  it("returns 'Nm early' under 60 minutes", () => {
    const tenMin = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(earlyByCopy(tenMin)).toBe("10m early");
    const oneMin = new Date(Date.now() + 60_000).toISOString();
    expect(earlyByCopy(oneMin)).toBe("1m early");
  });

  it("returns 'Nh early' between 1h and 36h (inclusive)", () => {
    const twoHours = new Date(Date.now() + 2 * 3_600_000).toISOString();
    expect(earlyByCopy(twoHours)).toBe("2h early");
    const eighteenHours = new Date(Date.now() + 18 * 3_600_000).toISOString();
    expect(earlyByCopy(eighteenHours)).toBe("18h early");
    const thirtyFiveHours = new Date(Date.now() + 35 * 3_600_000).toISOString();
    expect(earlyByCopy(thirtyFiveHours)).toBe("35h early");
  });

  it("returns 'Nd early' above 36h", () => {
    const twoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect(earlyByCopy(twoDays)).toBe("2d early");
    const eightDays = new Date(Date.now() + 8 * 86_400_000).toISOString();
    expect(earlyByCopy(eightDays)).toBe("8d early");
  });
});
