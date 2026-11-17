import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "@oneshot-gtm/core";
import { configCalls } from "../src/commands/config.ts";

describe("config calls", () => {
  it("switches calls, sets and removes the step, sets the window, and keeps a bridge", async () => {
    const bridge = {
      provider: "twilio" as const,
      founderPhone: "+15550001111",
      callerId: "+15550002222",
    };
    saveConfig({ ...loadConfig(), calls: { enabled: false, bridge } });
    await configCalls("on");
    expect(loadConfig().calls).toEqual({ enabled: true, bridge });

    await configCalls("step", ["3", "5"]);
    expect(loadConfig().calls?.cadenceStep).toEqual({ position: 3, delayDays: 5, holdDays: 3 });
    await configCalls("step", ["2", "1", "4"]);
    expect(loadConfig().calls?.cadenceStep).toEqual({ position: 2, delayDays: 1, holdDays: 4 });
    for (const bad of [["1"], ["2.5"], ["3abc"], ["3", "-1"], ["3", "2", "0"]]) {
      await expect(configCalls("step", bad)).rejects.toThrow(/invalid/);
    }
    await configCalls("step", ["off"]);
    expect(loadConfig().calls?.cadenceStep).toBeNull();

    await configCalls("window", ["10:00-16:00", "every-day"]);
    expect(loadConfig().calls?.window).toEqual({ start: "10:00", end: "16:00", weekdays: false });
    await expect(configCalls("window", ["17:00-09:00"])).rejects.toThrow(/invalid window/);
    await expect(configCalls("window", ["09:00-17:00", "sometimes"])).rejects.toThrow(
      /invalid days/,
    );
    await expect(configCalls("ring")).rejects.toThrow(/unknown action/);

    await configCalls();
    await configCalls("off");
    expect(loadConfig().calls).toMatchObject({ enabled: false, bridge });
  });
});
