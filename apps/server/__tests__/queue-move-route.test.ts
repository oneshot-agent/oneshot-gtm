import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/queue/:id/move. The source side of a cross-workspace move.
// Registry from a temp dir (never the real one); every network call stubbed:
// the destination's health probe and its /api/queue/import.

const tmp = mkdtempSync(join(tmpdir(), "oneshot-move-route-"));
const alphaHome = join(tmp, "alpha");
mkdirSync(alphaHome, { recursive: true });
writeFileSync(
  join(tmp, "registry.json"),
  JSON.stringify({
    default: "default",
    workspaces: { alpha: { home: alphaHome, port: 3999, createdAt: "2026-08-24T00:00:00Z" } },
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
/** When set, the stubbed import also stamps the source row `sent`, as a concurrent drain would. */
let sentDuringImport = false;
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/api/health")) {
    if (!up) throw new Error("down");
    return new Response("{}", { status: 200 });
  }
  if (url.endsWith("/api/queue/import")) {
    importBodies.push(JSON.parse(String(init?.body)));
    if (sentDuringImport && row) {
      row.status = "sent";
      row.sent_at = new Date().toISOString();
    }
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
  drain_claimed_at: string | null;
};
let row: Row | null = null;
/** Every status/notes write, in order. The reserve/restore dance is the point. */
const statusCalls: Array<Record<string, unknown>> = [];
const noteCalls: Array<Record<string, unknown>> = [];
/** Every compare-and-set restore attempt (#983), with whether it landed. */
const restoreCalls: Array<Record<string, unknown>> = [];
/** The per-move id is random; a move's note is `moved to <workspace> #<8 hex>`. */
const movedTo = (workspace: string, prefix = "") =>
  new RegExp(`^${prefix}moved to ${workspace} #[0-9a-f]{8}$`);

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getQueueRow: () => row,
      setQueueStatus: (input: Record<string, unknown>) => {
        statusCalls.push(input);
        // Mirror the write so the post-import re-read sees it.
        if (row && typeof input["status"] === "string") row.status = input["status"];
        if (row && typeof input["notes"] === "string") row.notes = input["notes"];
      },
      setQueueNotes: (input: Record<string, unknown>) => {
        noteCalls.push(input);
        if (row && typeof input["notes"] === "string") row.notes = input["notes"];
      },
      restoreQueueMoveIf: (input: {
        id: number;
        reservedNotes: string;
        status: string;
        notes: string | null;
      }) => {
        // Mirror the ledger's single UPDATE: lands only while the row is still
        // `rejected` with the reservation note, never puts a sent row back live.
        const live = input.status === "pending" || input.status === "approved";
        const landed =
          !!row &&
          row.status === "rejected" &&
          row.notes === input.reservedNotes &&
          !(live && row.sent_at != null);
        restoreCalls.push({ ...input, landed });
        if (landed && row) {
          row.status = input.status;
          row.notes = input.notes === "" ? null : input.notes;
        }
        return landed;
      },
    }),
  };
});

const { moveQueueRowRoute, moveNote, REJECT_REASON_MAX_CHARS } =
  await import("../src/api/queue.ts");
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
  noteCalls.length = 0;
  restoreCalls.length = 0;
  sentDuringImport = false;
  fetchMock.mockClear();
  _setLaunchSpawn();
  row = {
    id: 746,
    play_name: "accelerator-batch",
    payload_json: JSON.stringify({
      name: "Ada",
      email: "ada@example.com",
      cohort: "yc-w26",
      yourEdge: "the beta edge",
      icpVerdict: "pass",
    }),
    dedupe_key: "acc:ada@example.com",
    source: "find:accelerator-batch:yc-w26",
    status: "pending",
    notes: null,
    sent_at: null,
    send_started_at: null,
    drain_claimed_at: null,
  };
});

describe("moveNote", () => {
  it("writes the destination and move id, appends to a human reason, replaces a machine one", () => {
    expect(moveNote(null, "alpha", "a1")).toBe("moved to alpha #a1");
    expect(moveNote("wrong stage", "alpha", "a1")).toBe("wrong stage · moved to alpha #a1");
    expect(moveNote("auto: batch too old", "alpha", "a1")).toBe("moved to alpha #a1");
  });

  it("replaces an earlier move's marker, with or without an id, so the note names the move that holds the row", () => {
    expect(moveNote("wrong stage · moved to alpha #a1", "alpha", "b2")).toBe(
      "wrong stage · moved to alpha #b2",
    );
    expect(moveNote("moved to alpha #a1", "beta", "b2")).toBe("moved to beta #b2");
    expect(moveNote("wrong stage · moved to alpha", "alpha", "b2")).toBe(
      "wrong stage · moved to alpha #b2",
    );
    expect(moveNote("they moved to Berlin", "alpha", "b2")).toBe(
      "they moved to Berlin · moved to alpha #b2",
    );
  });

  it("trims a long reason to the cap and never the move marker", () => {
    const note = moveNote("x".repeat(400), "alpha", "a1b2c3d4");
    expect(note).toHaveLength(REJECT_REASON_MAX_CHARS);
    expect(note.endsWith(" · moved to alpha #a1b2c3d4")).toBe(true);
  });
});

describe("POST /api/queue/:id/move", () => {
  it("imports the portable payload into the running destination, then rejects the row here", async () => {
    const res = await moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      destination: { name: "alpha", port: 3999, queueId: 77, reused: false },
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
      {
        id: 746,
        status: "rejected",
        decidedBy: "human",
        decisionReason: "other",
        notes: expect.stringMatching(movedTo("alpha")),
      },
    ]);
  });

  it("keeps an already-rejected row's reason and appends the destination", async () => {
    row!.status = "rejected";
    row!.notes = "wrong industry";
    const res = await moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
    expect(res.status).toBe(200);
    expect(statusCalls[0]?.["notes"]).toMatch(movedTo("alpha", "wrong industry · "));
  });

  it("starts a stopped destination and waits for it before importing", async () => {
    up = false;
    const spawned: string[] = [];
    _setLaunchSpawn(({ env }) => {
      spawned.push(`${env["ONESHOT_GTM_WORKSPACE"]}:${env["PORT"]}`);
      up = true; // the child "comes up" before the next probe
    });
    const res = await moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
    expect(res.status).toBe(200);
    expect(spawned).toEqual(["alpha:3999"]);
    expect(importBodies).toHaveLength(1);
  });

  it("reserves the row as rejected before the awaits and restores it when the destination refuses", async () => {
    row!.status = "approved";
    row!.notes = "looks good";
    importReply = {
      status: 409,
      body: { error: "already sent to this person from this workspace (row #9)" },
    };
    const res = await moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("alpha: already sent");
    // Reserved first (nothing can drain it during the awaits), then put back
    // through one compare-and-set on the note the reservation wrote.
    expect(statusCalls.map((c) => c["status"])).toEqual(["rejected"]);
    expect(restoreCalls).toEqual([
      {
        id: 746,
        reservedNotes: statusCalls[0]?.["notes"],
        status: "approved",
        notes: "looks good",
        landed: true,
      },
    ]);
    expect(noteCalls).toEqual([]);
    expect(row).toMatchObject({ status: "approved", notes: "looks good" });
  });

  it("leaves the row alone when its note changed under the reservation (restore is a compare-and-set)", async () => {
    let release!: (response: Response) => void;
    const paused = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    fetchMock.mockResolvedValueOnce(new Response("{}"));
    fetchMock.mockImplementationOnce(() => {
      reached();
      return paused;
    });
    const moving = moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
    await waiting;
    // The founder rejects the row by hand while the destination is slow.
    row!.notes = "wrong stage";
    release(new Response(JSON.stringify({ error: "refused" }), { status: 409 }));
    expect((await moving).status).toBe(409);
    expect(restoreCalls).toEqual([expect.objectContaining({ status: "pending", landed: false })]);
    expect(row).toMatchObject({ status: "rejected", notes: "wrong stage" });
  });

  it("restores the row when the destination cannot be started", async () => {
    up = false;
    _setLaunchSpawn(() => {
      /* never comes up */
    });
    // #978 readiness now accommodates cold-boot cleanup; advance that wait
    // without making the rollback regression test spend 150s in real time.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const moving = moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
      await vi.runAllTimersAsync();
      const res = await moving;
      expect(res.status).toBe(503);
      expect(statusCalls.map((c) => c["status"])).toEqual(["rejected"]);
      expect(restoreCalls).toEqual([
        expect.objectContaining({ id: 746, status: "pending", notes: null, landed: true }),
      ]);
      expect(row).toMatchObject({ status: "pending", notes: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["startup", "refused import", "network"] as const)(
    "does not roll back a newer successful move after an older %s failure",
    async (failure) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      let release!: (response: Response) => void;
      let fail!: (error: Error) => void;
      const paused = new Promise<Response>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      if (failure !== "startup") fetchMock.mockResolvedValueOnce(new Response("{}"));
      fetchMock.mockImplementationOnce(() => {
        reached();
        return paused;
      });
      _setLaunchSpawn(() => {});
      try {
        const older = moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
        await waiting;
        const olderNote = row!.notes;
        // Same destination: only the per-move id in the note tells the two
        // reservations apart (#983).
        const newer = await moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
        expect(newer.status).toBe(200);
        expect(importBodies).toHaveLength(1);
        const newerNote = row!.notes;
        expect(newerNote).toMatch(movedTo("alpha"));
        expect(newerNote).not.toBe(olderNote);
        up = false;
        if (failure === "refused import") {
          release(new Response(JSON.stringify({ error: "refused" }), { status: 409 }));
        } else {
          fail(new Error("down"));
        }
        await vi.runAllTimersAsync();
        expect((await older).status).toBe(
          failure === "startup" ? 503 : failure === "refused import" ? 409 : 502,
        );
        // The second move's note stays: the first's failure restored nothing.
        expect(row).toMatchObject({ status: "rejected", notes: newerNote });
        expect(statusCalls.map((c) => c["status"])).toEqual(["rejected", "rejected"]);
        expect(restoreCalls).toEqual([]);
        expect(noteCalls).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["older", "neither"],
    ["newer", "neither"],
    ["older", "older"],
    ["newer", "older"],
    ["older", "newer"],
    ["newer", "newer"],
  ] as const)(
    "keeps concurrent moves reserved until settled: %s finishes first, %s succeeds",
    async (first, succeeds) => {
      row!.status = "approved";
      row!.notes = "looks good";
      const pauseImport = () => {
        let release!: (response: Response) => void;
        const paused = new Promise<Response>((resolve) => {
          release = resolve;
        });
        let reached!: () => void;
        const waiting = new Promise<void>((resolve) => {
          reached = resolve;
        });
        fetchMock.mockResolvedValueOnce(new Response("{}"));
        fetchMock.mockImplementationOnce(() => {
          reached();
          return paused;
        });
        const moving = moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
        return { moving, waiting, release };
      };
      const older = pauseImport();
      await older.waiting;
      const newer = pauseImport();
      await newer.waiting;
      const successful = succeeds === "older" ? older : succeeds === "newer" ? newer : null;
      const moves = first === "older" ? [older, newer] : [newer, older];
      let statusAfterFirst: string | undefined;
      for (const move of moves) {
        move.release(
          move === successful
            ? new Response(JSON.stringify({ queueId: 77 }), { status: 201 })
            : new Response(JSON.stringify({ error: "refused" }), { status: 409 }),
        );
        expect((await move.moving).status).toBe(move === successful ? 200 : 409);
        if (move === moves[0]) statusAfterFirst = row!.status;
      }
      expect(statusAfterFirst).toBe("rejected");
      if (successful) {
        expect(row).toMatchObject({ status: "rejected", notes: statusCalls[1]?.["notes"] });
        expect(row!.notes).toMatch(movedTo("alpha", "looks good · "));
        expect(statusCalls.map((c) => c["status"])).toEqual(["rejected", "rejected"]);
        expect(restoreCalls).toEqual([]);
      } else {
        expect(row).toMatchObject({ status: "approved", notes: "looks good" });
        expect(statusCalls.map((c) => c["status"])).toEqual(["rejected", "rejected"]);
        // One restore, after both settled, keyed on the latest reservation.
        expect(restoreCalls).toEqual([
          expect.objectContaining({
            reservedNotes: statusCalls[1]?.["notes"],
            status: "approved",
            notes: "looks good",
            landed: true,
          }),
        ]);
      }
      expect(noteCalls).toEqual([]);
    },
  );

  it("refuses a row the drain has leased in the last 15 minutes", async () => {
    row!.status = "approved";
    row!.drain_claimed_at = new Date(Date.now() - 60_000).toISOString();
    const res = await moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
    expect(res.status).toBe(409);
    expect(statusCalls).toHaveLength(0);
    expect(importBodies).toHaveLength(0);
  });

  it("reports a send that landed mid-move instead of pretending the row left", async () => {
    // The destination import "takes long enough" for a drain send to stamp `sent`.
    sentDuringImport = true;
    const res = await moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      "sent from here while moving",
    );
  });

  it("refuses a sent or in-flight row, the current workspace, an unknown one, and a bad body", async () => {
    row!.status = "sent";
    row!.sent_at = "2026-09-01T00:00:00Z";
    expect((await moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" })).status).toBe(409);
    row!.status = "pending";
    row!.sent_at = null;
    expect((await moveQueueRowRoute(req({ workspace: "default" }), { id: "746" })).status).toBe(
      400,
    );
    expect((await moveQueueRowRoute(req({ workspace: "nope" }), { id: "746" })).status).toBe(404);
    expect((await moveQueueRowRoute(req({}), { id: "746" })).status).toBe(400);
    row = null;
    expect((await moveQueueRowRoute(req({ workspace: "alpha" }), { id: "746" })).status).toBe(404);
    expect(importBodies).toHaveLength(0);
    expect(statusCalls).toHaveLength(0);
  });
});
