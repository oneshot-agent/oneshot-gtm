import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "@oneshot-gtm/core";
import { configLinkedInInvites } from "../src/commands/config.ts";

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
