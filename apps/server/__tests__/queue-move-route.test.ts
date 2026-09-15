import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/queue/:id/move — the source side of a cross-workspace move.
// Registry from a temp dir (never the real one); every network call stubbed:
// the destination's health probe and its /api/queue/import.

const tmp = mkdtempSync(join(tmpdir(), "oneshot-move-route-"));
const gtmHome = join(tmp, "gtm");
mkdirSync(gtmHome, { recursive: true });
writeFileSync(
  join(tmp, "registry.json"),
  JSON.stringify({
    default: "default",
    workspaces: { gtm: { home: gtmHome, port: 3999, createdAt: "2026-08-24T00:00:00Z" } },
  }),
);
process.env["ONESHOT_GTM_WORKSPACES"] = tmp;
process.env["ONESHOT_GTM_WORKSPACE"] = "default";
process.env["PORT"] = "3030";

/** What the stubbed destination does: health answers only once `up`; import answers `importReply`. */
let up = true;
let importReply: { status: number; body: unknown } = {
  status: 201,
  body: { queueId: 77, reused: false },
};
const importBodies: unknown[] = [];
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/api/health")) {
    if (!up) throw new Error("down");
    return new Response("{}", { status: 200 });
  }
  if (url.endsWith("/api/queue/import")) {
    importBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(importReply.body), { status: importReply.status });
  }
  throw new Error(`unexpected fetch ${url}`);
});
vi.stubGlobal("fetch", fetchMock);

type Row = {
  id: number;
  play_name: string;
  payload_json: string;
  dedupe_key: string;
  source: string | null;
  status: string;
  notes: string | null;
  sent_at: string | null;
  send_started_at: string | null;
};
let row: Row | null = null;
const statusCalls: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getQueueRow: () => row,
      setQueueStatus: (input: Record<string, unknown>) => {
        statusCalls.push(input);
      },
    }),
  };
});

const { moveQueueRowRoute, moveNote } = await import("../src/api/queue.ts");
const { _setLaunchSpawn } = await import("../src/api/workspace.ts");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const req = (body: unknown) =>
  new Request("http://127.0.0.1:3030/api/queue/746/move", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  up = true;
  importReply = { status: 201, body: { queueId: 77, reused: false } };
  importBodies.length = 0;
  statusCalls.length = 0;
  fetchMock.mockClear();
  _setLaunchSpawn();
  row = {
    id: 746,
    play_name: "accelerator-batch",
    payload_json: JSON.stringify({
      name: "Ada",
      email: "ada@example.com",
      cohort: "yc-w26",
      yourEdge: "the sdk edge",
      icpVerdict: "pass",
    }),
    dedupe_key: "acc:ada@example.com",
    source: "find:accelerator-batch:yc-w26",
    status: "pending",
    notes: null,
    sent_at: null,
    send_started_at: null,
  };
});

describe("moveNote", () => {
  it("writes the destination, appends to a human reason, replaces a machine one", () => {
    expect(moveNote(null, "gtm")).toBe("moved to gtm");
    expect(moveNote("wrong stage", "gtm")).toBe("wrong stage · moved to gtm");
    expect(moveNote("wrong stage · moved to gtm", "gtm")).toBe("wrong stage · moved to gtm");
    expect(moveNote("auto: batch too old", "gtm")).toBe("moved to gtm");
  });
});

describe("POST /api/queue/:id/move", () => {
  it("imports the portable payload into the running destination, then rejects the row here", async () => {
    const res = await moveQueueRowRoute(req({ workspace: "gtm" }), { id: "746" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      destination: { name: "gtm", port: 3999, queueId: 77, reused: false },
    });
    expect(importBodies).toHaveLength(1);
    const sent = importBodies[0] as Record<string, unknown>;
    expect(sent["playName"]).toBe("accelerator-batch");
    expect(sent["dedupeKey"]).toBe("acc:ada@example.com");
    expect(sent["source"]).toBe("find:accelerator-batch:yc-w26");
    expect(sent["movedFrom"]).toEqual({ workspace: "default", queueId: 746 });
    const payload = sent["payload"] as Record<string, unknown>;
    expect(payload).toEqual({ name: "Ada", email: "ada@example.com", cohort: "yc-w26" });
    expect(statusCalls).toEqual([
      { id: 746, status: "rejected", decidedBy: "human", notes: "moved to gtm" },
    ]);
  });

  it("keeps an already-rejected row's reason and appends the destination", async () => {
    row!.status = "rejected";
    row!.notes = "wrong industry";
    const res = await moveQueueRowRoute(req({ workspace: "gtm" }), { id: "746" });
    expect(res.status).toBe(200);
    expect(statusCalls[0]?.["notes"]).toBe("wrong industry · moved to gtm");
  });

  it("starts a stopped destination and waits for it before importing", async () => {
    up = false;
    const spawned: string[] = [];
    _setLaunchSpawn(({ env }) => {
      spawned.push(`${env["ONESHOT_GTM_WORKSPACE"]}:${env["PORT"]}`);
      up = true; // the child "comes up" before the next probe
    });
    const res = await moveQueueRowRoute(req({ workspace: "gtm" }), { id: "746" });
    expect(res.status).toBe(200);
    expect(spawned).toEqual(["gtm:3999"]);
    expect(importBodies).toHaveLength(1);
  });

  it("passes the destination's refusal through and leaves the row here untouched", async () => {
    importReply = {
      status: 409,
      body: { error: "already sent to this person from this workspace (row #9)" },
    };
    const res = await moveQueueRowRoute(req({ workspace: "gtm" }), { id: "746" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("gtm: already sent");
    expect(statusCalls).toHaveLength(0);
  });

  it("refuses a sent or in-flight row, the current workspace, an unknown one, and a bad body", async () => {
    row!.status = "sent";
    row!.sent_at = "2026-09-01T00:00:00Z";
    expect((await moveQueueRowRoute(req({ workspace: "gtm" }), { id: "746" })).status).toBe(409);
    row!.status = "pending";
    row!.sent_at = null;
    expect((await moveQueueRowRoute(req({ workspace: "default" }), { id: "746" })).status).toBe(
      400,
    );
    expect((await moveQueueRowRoute(req({ workspace: "nope" }), { id: "746" })).status).toBe(404);
    expect((await moveQueueRowRoute(req({}), { id: "746" })).status).toBe(400);
    row = null;
    expect((await moveQueueRowRoute(req({ workspace: "gtm" }), { id: "746" })).status).toBe(404);
    expect(importBodies).toHaveLength(0);
    expect(statusCalls).toHaveLength(0);
  });
});
