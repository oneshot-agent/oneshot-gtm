import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";
import type { OneShotConfig } from "@oneshot-gtm/core";
let ledger: Ledger;
let config: OneShotConfig;
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  loadConfig: () => config,
  saveConfig: (value: OneShotConfig) => {
    config = value;
  },
}));
vi.mock("../src/server.ts", () => ({
  jsonResponse: (data: unknown, status = 200) => Response.json(data, { status }),
}));
const { setCadenceRoute, listPlays } = await import("../src/api/plays.ts");
beforeEach(() => {
  ledger = new Ledger(":memory:");
  config = {} as OneShotConfig;
});
afterEach(() => ledger.close());
const save = (directMail: unknown) =>
  setCadenceRoute(
    new Request("http://local/api/plays/new-business/cadence", {
      method: "POST",
      body: JSON.stringify({ directMail }),
    }),
    { name: "new-business" },
  );
it("persists off rather than reverting to the default, and allows automatic mode again", async () => {
  const play = async () => {
    const result = await listPlays(new Request("http://local/api/plays")).json();
    return result.plays.find((p: { name: string }) => p.name === "new-business");
  };
  expect((await play()).directMail.mode).toBe("automatic");
  expect((await save(null)).status).toBe(200);
  expect(config.directMailMotions?.["new-business"]).toBeNull();
  expect((await play()).directMail).toBeNull();
  expect((await save({ position: 2, delayDays: 3, mode: "automatic" })).status).toBe(200);
  expect((await play()).directMail.mode).toBe("automatic");
  expect((await save({ position: 2, delayDays: 3, mode: "invalid" })).status).toBe(400);
});
