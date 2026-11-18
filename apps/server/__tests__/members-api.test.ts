import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSharedDb, SharedDb } from "@oneshot-gtm/core";
import { buildFetchHandler } from "../src/server.ts";

const handler = buildFetchHandler();
const host = "gtm.example.ts.net";
const owner = "owner@example.com";
const member = "mia@example.com";
let dir: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env["ONESHOT_GTM_SHARED"];
  dir = mkdtempSync(join(tmpdir(), "members-api-"));
  process.env["ONESHOT_GTM_SHARED"] = dir;
  const db = getSharedDb();
  db.allowHost(host);
  db.addMember({ email: owner, name: "Olive", role: "owner" });
  db.addMember({ email: member, name: "Mia", role: "member" });
});
afterEach(() => {
  if (previous === undefined) delete process.env["ONESHOT_GTM_SHARED"];
  else process.env["ONESHOT_GTM_SHARED"] = previous;
  getSharedDb();
  rmSync(dir, { recursive: true, force: true });
});
function request(path = "/api/members", body?: unknown, who = owner) {
  return handler(
    new Request(`https://${host}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { host, "tailscale-user-login": who, origin: `https://${host}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

it("lists active member details and allowed hosts for a member", async () => {
  const response = await request("/api/members", undefined, member);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    members: [
      { email: owner, name: "Olive", role: "owner", addedAt: expect.any(String) },
      { email: member, name: "Mia", role: "member", addedAt: expect.any(String) },
    ],
    allowedHosts: [host],
    currentMember: { email: member, name: "Mia", role: "member" },
  });
});

it("an owner adds, promotes, demotes, removes and restores a member", async () => {
  const email = "new@example.com";
  expect((await request("/api/members", { email: " New@Example.com " })).status).toBe(200);
  expect(getSharedDb().activeMember(email)?.role).toBe("member");
  for (const role of ["owner", "member"]) {
    expect((await request("/api/members/role", { email, role })).status).toBe(200);
    expect(getSharedDb().activeMember(email)?.role).toBe(role);
  }
  expect((await request("/api/members/remove", { email })).status).toBe(200);
  expect(getSharedDb().activeMember(email)).toBeNull();
  expect((await request("/api/members", { email })).status).toBe(200);
  expect(getSharedDb().activeMember(email)?.role).toBe("member");
});

it.each(["", "/remove", "/role"])("a member gets 403 on POST /api/members%s", async (action) => {
  const before = getSharedDb().listMembers();
  const response = await request(`/api/members${action}`, { email: member, role: "owner" }, member);
  expect(response.status).toBe(403);
  expect(getSharedDb().listMembers()).toEqual(before);
});

it.each(["/remove", "/role"])("refuses losing the last owner through %s", async (action) => {
  // Removed owners do not count towards the invariant.
  getSharedDb().addMember({ email: "old@example.com", role: "owner" });
  getSharedDb().removeMember("old@example.com");
  const response = await request(`/api/members${action}`, { email: owner, role: "member" });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: expect.stringContaining("last owner") });
  expect(getSharedDb().activeMember(owner)?.role).toBe("owner");
});

it("a removed member's very next dashboard request gets 403", async () => {
  expect((await request("/api/me", undefined, member)).status).toBe(200);
  expect((await request("/api/members/remove", { email: member })).status).toBe(200);
  expect((await request("/api/me", undefined, member)).status).toBe(403);
});

it("a demoted owner immediately loses mutation permissions", async () => {
  expect((await request("/api/members/role", { email: member, role: "owner" })).status).toBe(200);
  expect(
    (await request("/api/members/role", { email: owner, role: "member" }, member)).status,
  ).toBe(200);
  expect((await request("/api/members", { email: "new@example.com" })).status).toBe(403);
});

it("rejects malformed input and unknown targets without changing members", async () => {
  const before = getSharedDb().listMembers();
  for (const body of [null, [], {}, { email: 42 }, { email: "bad" }]) {
    expect((await request("/api/members", body)).status).toBe(400);
  }
  expect((await request("/api/members/role", { email: member, role: "admin" })).status).toBe(400);
  for (const action of ["/role", "/remove"]) {
    expect(
      (await request(`/api/members${action}`, { email: "unknown@example.com", role: "owner" }))
        .status,
    ).toBe(404);
  }
  expect(getSharedDb().listMembers()).toEqual(before);
});

it("adding an existing owner again preserves their role, name and added date", async () => {
  const before = getSharedDb().activeMember(owner);
  expect((await request("/api/members", { email: owner })).status).toBe(200);
  expect(getSharedDb().activeMember(owner)).toEqual(before);
});

it("the local owner can add the first member without a listed identity", async () => {
  process.env["ONESHOT_GTM_SHARED"] = join(dir, "empty");
  const response = await handler(
    new Request("http://127.0.0.1:3030/api/members", {
      method: "POST",
      headers: { host: "127.0.0.1:3030" },
      body: JSON.stringify({ email: member }),
    }),
  );
  expect(response.status).toBe(200);
  expect(getSharedDb().activeMember(member)?.role).toBe("member");
});

it.each(["x-forwarded-for", "x-forwarded-host", "forwarded", "tailscale-funnel-request"])(
  "refuses member reads and writes through a loopback proxy carrying %s without allowed hosts",
  async (header) => {
    getSharedDb().disallowHost(host);
    const before = getSharedDb().listMembers();
    for (const path of ["", "/remove", "/role"]) {
      const response = await handler(
        new Request(`http://127.0.0.1:3030/api/members${path}`, {
          method: "POST",
          headers: { host: "127.0.0.1:3030", [header]: "hooks.example.com" },
          body: JSON.stringify({ email: member, role: "owner" }),
        }),
      );
      expect(response.status).toBe(403);
    }
    const response = await handler(
      new Request("http://127.0.0.1:3030/api/members", {
        headers: { host: "127.0.0.1:3030", [header]: "hooks.example.com" },
      }),
    );
    expect(response.status).toBe(403);
    expect(getSharedDb().listMembers()).toEqual(before);
  },
);

it("a role change cannot restore a target removed by another workspace after its active check", async () => {
  const db = getSharedDb();
  const other = new SharedDb(join(dir, "shared.sqlite"));
  const activeMember = db.activeMember.bind(db);
  let removed = false;
  const spy = vi.spyOn(db, "activeMember").mockImplementation((email) => {
    const active = activeMember(email);
    if (email === member && !removed) {
      removed = true;
      expect(other.removeMember(member)).toBe(true);
    }
    return active;
  });
  try {
    const response = await request("/api/members/role", { email: member, role: "owner" });
    expect(response.status).toBe(404);
    expect(activeMember(member)).toBeNull();
  } finally {
    spy.mockRestore();
    other.close();
  }
});
