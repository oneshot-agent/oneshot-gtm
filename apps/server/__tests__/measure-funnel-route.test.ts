import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { getLedger, loadConfig, saveConfig } from "@oneshot-gtm/core";
import type { FunnelView } from "@oneshot-gtm/shared-types";
import { measureFunnel } from "../src/api/measure.ts";

// GET /api/measure/funnel over a real ledger in the isolated test home.

const req = (qs = ""): Request =>
  new Request(`http://localhost/api/measure/funnel${qs}`, {
    headers: { host: "127.0.0.1:3030" },
  });

const raw = (): Database => new Database(`${process.env["ONESHOT_GTM_HOME"]}/ledger.sqlite`);

/** Local noon `daysAgo` days back: far from midnight in any zone. */
function localNoon(daysAgo: number): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo, 12);
}
const dayOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let seq = 0;
function queue(
  source: string,
  daysAgo: number,
  status: string,
  decidedBy: string | null = null,
  decidedDaysAgo: number | null = null,
): void {
  const db = raw();
  db.prepare(
    `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, status, found_at, decided_by, decided_at)
     VALUES('p', '{}', ?, ?, ?, ?, ?, ?)`,
  ).run(
    `k${++seq}`,
    source,
    status,
    localNoon(daysAgo).toISOString().slice(0, 19).replace("T", " "),
    decidedBy,
    decidedDaysAgo == null ? null : localNoon(decidedDaysAgo).toISOString(),
  );
  db.close();
}

function finderRun(name: string, source: string, daysAgo: number, costUsd: number): void {
  const at = localNoon(daysAgo).toISOString();
  getLedger().insertFinderRun({
    name,
    source,
    startedAt: at,
    finishedAt: at,
    candidates: 10,
    enqueued: 3,
    droppedDuplicate: 4,
    droppedEnrichment: 1,
    droppedRole: 1,
    droppedIcp: 1,
    costUsd,
    halted: null,
  });
}

async function view(qs = ""): Promise<FunnelView> {
  const res = measureFunnel(req(qs));
  expect(res.status).toBe(200);
  return (await res.json()) as FunnelView;
}

beforeEach(() => {
  getLedger(); // creates the schema in the isolated home
  const db = raw();
  db.exec("DELETE FROM target_queue; DELETE FROM finder_runs;");
  db.close();
  saveConfig({ ...loadConfig(), volumeGoalPerDay: null });
});

describe("measureFunnel", () => {
  it("joins runs and queue rows per day and source, with cost per queued and per approved", async () => {
    finderRun("hiring-signal", "find:hiring-signal", 0, 1);
    finderRun("hiring-signal", "find:hiring-signal", 0, 0.5);
    queue("find:hiring-signal", 0, "approved", "human", 0);
    queue("find:hiring-signal", 0, "sent", "human_bulk", 0);
    queue("find:hiring-signal", 0, "pending");
    queue("find:hiring-signal", 0, "rejected", "human", 0);
    queue("find:hiring-signal", 0, "rejected", "machine", 0);
    // A run that queued nothing: costs, no divisor.
    finderRun("show-hn", "find:show-hn", 0, 0.2);
    // An import with no runs is listed under its source.
    queue("csv:import", 0, "pending");
    // Found three days ago, approved today: counts on today's approvedOnDay only.
    queue("find:show-hn", 3, "approved", "human", 0);

    const body = await view();
    expect(body.goalPerDay).toBeNull();
    expect(body.days).toHaveLength(14);
    expect(body.days[0]!.day).toBe(dayOf(localNoon(0)));
    expect(body.days[13]!.day).toBe(dayOf(localNoon(13)));

    const today = body.days[0]!;
    expect(today.approvedOnDay).toBe(3);
    expect(today.finders).toEqual([
      {
        name: "hiring-signal",
        source: "find:hiring-signal",
        runs: 2,
        candidates: 20,
        enqueued: 6,
        queued: 4,
        autoRejected: 1,
        approved: 2,
        rejected: 1,
        sent: 1,
        pending: 1,
        costUsd: 1.5,
        costPerQueued: 0.375,
        costPerApproved: 0.75,
      },
      {
        name: "csv:import",
        source: "csv:import",
        runs: 0,
        candidates: 0,
        enqueued: 0,
        queued: 1,
        autoRejected: 0,
        approved: 0,
        rejected: 0,
        sent: 0,
        pending: 1,
        costUsd: 0,
        costPerQueued: 0,
        costPerApproved: null,
      },
      {
        name: "show-hn",
        source: "find:show-hn",
        runs: 1,
        candidates: 10,
        enqueued: 3,
        queued: 0,
        autoRejected: 0,
        approved: 0,
        rejected: 0,
        sent: 0,
        pending: 0,
        costUsd: 0.2,
        costPerQueued: null,
        costPerApproved: null,
      },
    ]);
    const threeAgo = body.days[3]!;
    expect(threeAgo.approvedOnDay).toBe(0);
    expect(threeAgo.finders.map((f) => [f.source, f.queued, f.approved])).toEqual([
      ["find:show-hn", 1, 1],
    ]);
    expect(body.days[1]!.finders).toEqual([]);
  });

  it("lists every trigger that shares a source under one entry", async () => {
    finderRun("list-page-b", "find:list-page", 0, 0.1);
    finderRun("list-page-a", "find:list-page", 0, 0.1);
    const [f] = (await view()).days[0]!.finders;
    expect(f).toMatchObject({ name: "list-page-a, list-page-b", runs: 2 });
  });

  it("clamps days to 1-90, defaults to 14, and leaves out what is older", async () => {
    finderRun("show-hn", "find:show-hn", 5, 0.2);
    queue("find:show-hn", 5, "pending");
    expect((await view("?days=500")).days).toHaveLength(90);
    expect((await view("?days=0")).days).toHaveLength(1);
    expect((await view("?days=-3")).days).toHaveLength(1);
    expect((await view("?days=nope")).days).toHaveLength(14);
    const short = await view("?days=3");
    expect(short.days.map((d) => d.day)).toEqual([0, 1, 2].map((i) => dayOf(localNoon(i))));
    expect(short.days.flatMap((d) => d.finders)).toEqual([]);
    expect((await view("?days=6")).days[5]!.finders).toHaveLength(1);
  });

  it("returns the configured daily goal", async () => {
    saveConfig({ ...loadConfig(), volumeGoalPerDay: 50 });
    expect((await view()).goalPerDay).toBe(50);
  });
});
