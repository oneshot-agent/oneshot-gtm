import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "@oneshot-gtm/core";
import { configLinkedInInvites, configLinkedInInviteTimeout } from "../src/commands/config.ts";

describe("config linkedin-invites", () => {
  it("sets, shows and clears the workspace share, refusing anything but a positive integer", async () => {
    saveConfig({ ...loadConfig(), linkedin: undefined });
    await configLinkedInInvites("12");
    expect(loadConfig().linkedin).toEqual({ invitesPerDay: 12 });

    for (const bad of ["0", "-3", "2.5", "12abc", "many", ""]) {
      await expect(configLinkedInInvites(bad)).rejects.toThrow(/invalid count/);
    }
    expect(loadConfig().linkedin).toEqual({ invitesPerDay: 12 });

    await configLinkedInInvites();
    await configLinkedInInvites("off");
    expect(loadConfig().linkedin?.invitesPerDay).toBeUndefined();
  });
});

describe("config linkedin-invite-timeout", () => {
  it("sets, shows and clears the timeout, refusing anything but a positive integer", async () => {
    saveConfig({ ...loadConfig(), linkedin: { invitesPerDay: 5 } });
    await configLinkedInInviteTimeout("14");
    expect(loadConfig().linkedin).toEqual({ invitesPerDay: 5, inviteTimeoutDays: 14 });

    for (const bad of ["0", "-3", "2.5", "14abc", "never", ""]) {
      await expect(configLinkedInInviteTimeout(bad)).rejects.toThrow(/invalid days/);
    }
    expect(loadConfig().linkedin?.inviteTimeoutDays).toBe(14);

    await configLinkedInInviteTimeout();
    await configLinkedInInviteTimeout("off");
    expect(loadConfig().linkedin).toEqual({ invitesPerDay: 5 });
  });
});
