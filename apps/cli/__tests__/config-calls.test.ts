import { describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "@oneshot-gtm/core";
import { configCalls } from "../src/commands/config.ts";

describe("config calls", () => {
  it("switches calls, sets and removes the step, sets the window, and keeps a bridge", async () => {
    const bridge = { provider: "twilio" as const, transcriptionServiceSid: "GA1" };
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

    await configCalls("record", ["off"]);
    expect(loadConfig().calls?.bridge).toEqual({ ...bridge, record: false });
    await configCalls("record", ["always"]);
    expect(loadConfig().calls?.bridge).toEqual({ ...bridge, record: "always" });
    await configCalls("record", ["ask"]);
    expect(loadConfig().calls?.bridge).toEqual({ ...bridge, record: "ask" });
    await expect(configCalls("record", ["on"])).rejects.toThrow(/invalid record/);
    saveConfig({ ...loadConfig(), calls: { enabled: true, bridge: null } });
    await expect(configCalls("record", ["ask"])).rejects.toThrow(/off for this workspace/);
  });

  it("takes decimal digits only for the step's numbers, zero where it is allowed", async () => {
    saveConfig({ ...loadConfig(), calls: { enabled: true } });
    for (const bad of [
      ["1e1"],
      ["0x10"],
      ["2.0"],
      ["+3"],
      ["3", "1e0"],
      ["9007199254740993"],
      ["3", "", "2"],
      ["3", "366"],
      ["3", "2", "100000"],
    ]) {
      await expect(configCalls("step", bad)).rejects.toThrow(/invalid/);
    }
    await configCalls("step", [" 4 ", "0", "1"]);
    expect(loadConfig().calls?.cadenceStep).toEqual({ position: 4, delayDays: 0, holdDays: 1 });
    await configCalls("step", ["4", "365", "365"]);
    expect(loadConfig().calls?.cadenceStep).toEqual({ position: 4, delayDays: 365, holdDays: 365 });
  });

  it("says bridging is inactive while calls are off, and never revives a non-Twilio bridge", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("TWILIO_API_KEY_SID", "SK1");
    vi.stubEnv("TWILIO_API_KEY_SECRET", "secret");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      saveConfig({ ...loadConfig(), calls: { enabled: false } });
      await configCalls();
      const text = () => out.mock.calls.map((c) => String(c[0])).join("");
      expect(text()).toContain("set up but inactive while calls are off");
      expect(text()).not.toContain("Call rings");
      out.mockClear();
      saveConfig({ ...loadConfig(), calls: { enabled: true } });
      await configCalls();
      expect(text()).toContain("others get a tel: link");
    } finally {
      out.mockRestore();
      vi.unstubAllEnvs();
    }
    const other = { provider: "other" } as unknown as { provider: "twilio" };
    saveConfig({ ...loadConfig(), calls: { enabled: true, bridge: other } });
    await expect(configCalls("record", ["always"])).rejects.toThrow(/off for this workspace/);
    expect(loadConfig().calls?.bridge).toEqual(other);
  });
});
