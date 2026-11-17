import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSharedDb } from "@oneshot-gtm/core";
import { buildFetchHandler } from "../src/server.ts";

// The request gate: the host machine itself is the owner, and anyone else has
// to arrive on an allowed host with a member's sign-in, which is what
// `tailscale serve` puts in `Tailscale-User-Login`. Each test gets its own
// shared database, since that is where members and allowed hosts live.

const handler = buildFetchHandler();
const TAILNET = "gtm-host.tail1234.ts.net";
const LOOPBACK = { host: "127.0.0.1:3030" };
/** What `tailscale serve` adds in front of the server for a signed-in tailnet user. */
const viaTailscale = (login: string, host = `${TAILNET}:3030`): Record<string, string> => ({
  host,
  "x-forwarded-host": host,
  "x-forwarded-for": "100.64.0.7",
  "x-forwarded-proto": "https",
  "tailscale-user-login": login,
});

const get = (path: string, headers: Record<string, string>) =>
  handler(new Request(`http://127.0.0.1:3030${path}`, { headers }));
const post = (path: string, headers: Record<string, string>) =>
  handler(new Request(`http://127.0.0.1:3030${path}`, { method: "POST", headers }));
const SKIP_MAIL = "/api/cadences/1/skip-mail?play=post-funding";

let dir: string;
let sharedBefore: string | undefined;

beforeEach(() => {
  sharedBefore = process.env["ONESHOT_GTM_SHARED"];
  dir = mkdtempSync(join(tmpdir(), "oneshot-gtm-members-"));
  process.env["ONESHOT_GTM_SHARED"] = dir;
});
afterEach(() => {
  if (sharedBefore === undefined) delete process.env["ONESHOT_GTM_SHARED"];
  else process.env["ONESHOT_GTM_SHARED"] = sharedBefore;
  // Re-point the process-wide handle before the directory under it goes.
  getSharedDb();
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  const db = getSharedDb();
  db.addMember({ email: "Owner@Example.com", name: "Olive Owner", role: "owner" });
  db.addMember({ email: "mia@example.com", name: "Mia Member", role: "member" });
  db.addMember({ email: "gone@example.com", role: "member" });
  db.removeMember("gone@example.com");
  db.allowHost(TAILNET);
}

describe("loopback requests", () => {
  it("behave as before when no members exist", async () => {
    expect((await get("/api/health", LOOPBACK)).status).toBe(200);
    expect(
      (await post(SKIP_MAIL, { ...LOOPBACK, origin: "http://localhost:5173" })).status,
    ).not.toBe(403);
    expect((await post(SKIP_MAIL, LOOPBACK)).status).not.toBe(403);
    expect((await post(SKIP_MAIL, { ...LOOPBACK, origin: "https://evil.example" })).status).toBe(
      403,
    );
    const me = await get("/api/me", LOOPBACK);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ email: null, name: null, role: "owner" });
  });

  it("behave as before when members exist, and act as the listed owner", async () => {
    seed();
    expect((await get("/api/health", { host: "localhost:3030" })).status).toBe(200);
    expect(
      (await post(SKIP_MAIL, { ...LOOPBACK, origin: "http://localhost:5173" })).status,
    ).not.toBe(403);
    expect((await post(SKIP_MAIL, LOOPBACK)).status).not.toBe(403);
    expect((await post(SKIP_MAIL, { ...LOOPBACK, origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect(await (await get("/api/me", LOOPBACK)).json()).toEqual({
      email: "owner@example.com",
      name: "Olive Owner",
      role: "owner",
    });
  });

  it("are the local owner when the members list has no owner", async () => {
    getSharedDb().addMember({ email: "mia@example.com", role: "member" });
    expect(await (await get("/api/me", LOOPBACK)).json()).toEqual({
      email: null,
      name: null,
      role: "owner",
    });
  });

  it("behave as before behind a proxy that rewrites the Host, while no host is allowed", async () => {
    // docs/webhooks.md: a proxy in front of the server is a supported setup.
    getSharedDb().addMember({ email: "owner@example.com", role: "owner" });
    const proxied = { ...LOOPBACK, "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "hooks" };
    expect((await get("/api/health", proxied)).status).toBe(200);
    expect((await post(SKIP_MAIL, proxied)).status).not.toBe(403);
  });

  it("are refused when they came through tailscale serve with no host allowed: before the first is allowed, and after the last is disallowed", async () => {
    // Serve can be running while the allowed list is empty. It repeats the
    // Host it was sent in X-Forwarded-Host, so a forged loopback Host shows.
    const tagged = {
      ...LOOPBACK,
      "x-forwarded-host": "127.0.0.1:3030",
      "x-forwarded-for": "100.64.0.9",
      "x-forwarded-proto": "https",
    };
    const cases: Array<Record<string, string>> = [
      tagged,
      { host: "localhost:3030", "x-forwarded-host": "localhost:3030" },
      { ...LOOPBACK, "x-forwarded-host": "127.0.0.1:3030", "tailscale-funnel-request": "?1" },
      viaTailscale("mia@example.com", "127.0.0.1:3030"),
    ];
    const refused = async (): Promise<void> => {
      for (const headers of cases) {
        expect((await get("/api/me", headers)).status).toBe(403);
        // No Origin, the way a non-browser client posts.
        expect((await post(SKIP_MAIL, headers)).status).toBe(403);
      }
    };

    expect(getSharedDb().allowedHosts()).toEqual([]);
    await refused();

    seed();
    getSharedDb().disallowHost(TAILNET);
    expect(getSharedDb().allowedHosts()).toEqual([]);
    await refused();
    // The host machine itself is still the owner.
    expect((await get("/api/me", LOOPBACK)).status).toBe(200);
  });

  it("are refused when they came through a proxy once a host is allowed: a loopback Host alone is not the owner", async () => {
    seed();
    // `tailscale serve` picks its backend from the TLS name, so a tailnet
    // device can send any Host. A tagged device or a Funnel visitor gets no
    // identity header; a signed-in user gets one. Neither is the owner.
    const cases: Array<Record<string, string>> = [
      { ...LOOPBACK, "x-forwarded-for": "100.64.0.9", "x-forwarded-host": "127.0.0.1:3030" },
      { ...LOOPBACK, "tailscale-funnel-request": "?1" },
      viaTailscale("mia@example.com", "127.0.0.1:3030"),
      { ...LOOPBACK, "tailscale-user-login": "owner@example.com" },
    ];
    for (const headers of cases) {
      const res = await get("/api/me", headers);
      expect(res.status).toBe(403);
    }
  });
});

describe("requests on an allowed host", () => {
  it("pass with an active member's sign-in, and /api/me names that member", async () => {
    seed();
    expect((await get("/api/health", viaTailscale("mia@example.com"))).status).toBe(200);
    const me = await get("/api/me", viaTailscale("Mia@Example.com"));
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      email: "mia@example.com",
      name: "Mia Member",
      role: "member",
    });
    const owner = await get("/api/me", viaTailscale("owner@example.com", TAILNET));
    expect((await owner.json()).role).toBe("owner");
  });

  it("let a member's own page make mutating calls, route-level origin checks included", async () => {
    seed();
    const headers = { ...viaTailscale("mia@example.com"), origin: `https://${TAILNET}:3030` };
    expect((await post(SKIP_MAIL, headers)).status).not.toBe(403);
    // A page on another workspace's port of the same host is the same install.
    expect(
      (await post(SKIP_MAIL, { ...headers, origin: `https://${TAILNET}:4031` })).status,
    ).not.toBe(403);
    // The cancel route repeats the Origin check itself.
    expect((await post("/api/run/999999/cancel", headers)).status).not.toBe(403);
  });

  it("refuse an unknown email, a removed member and a missing sign-in", async () => {
    seed();
    const cases: Array<Record<string, string>> = [
      viaTailscale("stranger@example.com"),
      viaTailscale("gone@example.com"),
      viaTailscale(""),
      { host: `${TAILNET}:3030`, "x-forwarded-for": "100.64.0.9" },
    ];
    for (const headers of cases) {
      const res = await get("/api/health", headers);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("forbidden: not a member");
    }
  });

  it("refuse a member again once removed, and admit them when added back", async () => {
    seed();
    const db = getSharedDb();
    db.removeMember("mia@example.com");
    expect((await get("/api/health", viaTailscale("mia@example.com"))).status).toBe(403);
    db.addMember({ email: "mia@example.com", role: "member" });
    expect((await get("/api/health", viaTailscale("mia@example.com"))).status).toBe(200);
  });

  it("still refuse a cross-site POST", async () => {
    seed();
    const member = viaTailscale("mia@example.com");
    const evil = await post(SKIP_MAIL, { ...member, origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect((await evil.json()).error).toContain("cross-site");
    const crossSite = await post(SKIP_MAIL, {
      ...member,
      origin: `https://${TAILNET}:3030`,
      "sec-fetch-site": "cross-site",
    });
    expect(crossSite.status).toBe(403);
    expect(
      (await post("/api/run/999999/cancel", { ...member, origin: "https://evil.example" })).status,
    ).toBe(403);
  });

  it("read a non-ASCII sign-in the way Tailscale encodes it", async () => {
    seed();
    getSharedDb().addMember({ email: "zoë@example.com", role: "member" });
    const me = await get("/api/me", viaTailscale("=?utf-8?q?zo=C3=AB@example.com?="));
    expect(me.status).toBe(200);
    expect((await me.json()).email).toBe("zoë@example.com");
  });
});

describe("requests on a host that is not allowed", () => {
  it("are refused, member or not", async () => {
    seed();
    const other = "other-host.tail1234.ts.net:3030";
    for (const headers of [viaTailscale("mia@example.com", other), { host: "evil.example" }]) {
      const res = await get("/api/health", headers);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("forbidden: host not allowed");
    }
  });

  it("are refused again once the host is taken off the list", async () => {
    seed();
    expect((await get("/api/health", viaTailscale("mia@example.com"))).status).toBe(200);
    getSharedDb().disallowHost(TAILNET);
    expect((await get("/api/health", viaTailscale("mia@example.com"))).status).toBe(403);
  });
});
