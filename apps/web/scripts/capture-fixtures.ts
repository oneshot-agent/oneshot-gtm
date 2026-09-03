/**
 * Capture the demo API as a static tree, for the build that oneshot-gtm.com
 * vendors at /demo.
 *
 * Prereqs, from the repo root, against a home of its own so the screenshot
 * install at ~/.oneshot-gtm-demo is left alone:
 *
 *   bun run cli -- demo seed --home ~/.oneshot-gtm-demo-site
 *   ONESHOT_GTM_HOME=~/.oneshot-gtm-demo-site bun run cli -- find score-prospects --scope all
 *   bun run cli -- demo ui   --home ~/.oneshot-gtm-demo-site --port 3141 --no-browser
 *   bun run --cwd apps/web capture
 *
 * The scoring pass is not optional. `demo seed` leaves every row's priority
 * null, and a queue with no scores is missing the chip a real install shows
 * against every pending row. It reads stored payloads only: no network, no LLM,
 * no spend, and the numbers are the scorer's own.
 *
 * Seed with no --now so the ledger is anchored at the moment of capture. The
 * screenshots pin their anchor because a re-shoot has to match an earlier take;
 * this has the opposite requirement. A ledger anchored weeks back reports zero
 * sends and zero spend in every seven-day window on the Today page, which is a
 * demo that opens on an empty room.
 *
 * WHAT THIS WRITES IS PUBLISHED. The seeded install is fictional by
 * construction — Mira Vance, tracepoint.dev, placeholder credentials — but the
 * server still answers three questions about the machine it is running on:
 * /workspace enumerates the operator's OTHER workspaces by name, home and port,
 * and /doctor and /setup quote absolute paths. Those are scrubbed below, and
 * then a guard re-reads the whole tree and refuses to leave anything behind
 * that still looks like a home directory. The guard is the part that matters:
 * scrubbing is a list someone has to keep current, and a list is exactly the
 * thing that goes stale the day an endpoint gains a field.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fixturePath } from "../src/api/fixturePath.ts";

const PORT = process.env["CAPTURE_PORT"] ?? "3141";
const API = `http://127.0.0.1:${PORT}/api`;
const OUT = join(import.meta.dir, "..", "fixtures");

/** What every absolute path in a captured response is rewritten to. */
const PLACEHOLDER_HOME = "/home/founder/.oneshot-gtm";

const HOME = homedir();

// ── the seeds ────────────────────────────────────────────────────────────────
//
// Every path an api client read can produce, with the parameters the routes
// actually pass. Anything parameterised by data — a receipt id, a play chip on
// the queue's filter bar — is discovered from the responses instead, in
// `expand` below, so the captured set is the set the UI can reach rather than a
// cross-product mostly made of combinations no click produces.

const SEEDS = [
  "/home",
  "/doctor",
  "/workspace",
  "/triggers",
  "/packs",
  "/plays",
  "/inbox",
  "/setup",

  // Cadences: the "show all" toggle. `sinceRun` is only reachable from a link a
  // finished run writes, and no run can finish here.
  "/cadences",
  "/cadences?all=1",

  // Receipts: three call sites, three limits.
  "/receipts?limit=16",
  "/receipts?limit=200",
  "/receipts?limit=500",

  // Queue: the table (limit 200), the Today strip (16), and the nav's alert dot.
  "/queue?limit=16",
  "/queue?status=pending&limit=1",

  // Measure: all-time, 30d, 7d — the three range buttons.
  "/measure/cac",
  "/measure/rocs",
  "/measure/rocs-by-goal",
  "/measure/cac?sinceDays=30",
  "/measure/rocs?sinceDays=30",
  "/measure/rocs-by-goal?sinceDays=30",
  "/measure/cac?sinceDays=7",
  "/measure/rocs?sinceDays=7",
  "/measure/rocs-by-goal?sinceDays=7",

  // The queue table's status and order filters. The play chips come from
  // whatever each of these returns, which is how the UI builds them too.
  ...["", "pending", "approved", "rejected", "sent", "expired"].flatMap((status) =>
    ["", "ranked", "newest"].map((order) => {
      const q = new URLSearchParams();
      if (status) q.set("status", status);
      q.set("limit", "200");
      if (order) q.set("order", order);
      return `/queue?${q.toString()}`;
    }),
  ),
];

/** URLs a response makes reachable that no static list could know about. */
function expand(url: string, body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];

  if (url.startsWith("/receipts?")) {
    const { receipts } = body as { receipts?: Array<{ id: number }> };
    // Clicking a row opens its detail. Every row is clickable, so every row's
    // detail is part of the demo.
    return (receipts ?? []).map((r) => `/receipts/${r.id}`);
  }

  if (url.startsWith("/queue?") && !url.includes("play=")) {
    const { rows, approvedByPlay } = body as {
      rows?: Array<{ playName: string }>;
      approvedByPlay?: Record<string, unknown>;
    };
    // queue.tsx builds its play chips from the rows on the page plus any play
    // holding approved rows, so those are the chips a visitor can press.
    const plays = new Set([
      ...(rows ?? []).map((r) => r.playName),
      ...Object.keys(approvedByPlay ?? {}),
    ]);
    const [, query = ""] = url.split("?");
    return [...plays].map((play) => {
      const q = new URLSearchParams(query);
      q.set("play", play);
      return `/queue?${q.toString()}`;
    });
  }

  return [];
}

// ── scrubbing ────────────────────────────────────────────────────────────────

/**
 * /workspace is the one response that has to be rebuilt rather than edited.
 *
 * It returns the workspace registry, which is a list of every install on the
 * machine: the real default, and any named workspace, each with its home and
 * port. Rewriting the paths would still publish the names. The demo is one
 * install and cannot start another, so it ships as one entry.
 *
 * The port moves to 3030 with it. 3141 is a capture detail, and the header
 * prints it to a visitor as though it were where the dashboard lives.
 */
function scrubWorkspace(body: unknown): unknown {
  const { current } = body as { current?: { name: string } };
  const one = {
    name: current?.name ?? "demo",
    home: PLACEHOLDER_HOME,
    port: 3030,
    isCurrent: true,
    isDefault: true,
    running: true,
  };
  return { current: { name: one.name, home: one.home, port: one.port }, workspaces: [one] };
}

/**
 * Two passes, and the order is the whole point.
 *
 * The demo home goes first and lands on the placeholder whole, so
 * ~/.oneshot-gtm-demo-site reads as a plain install rather than as a demo home
 * nested inside one. Whatever absolute path is left after that belongs to the
 * machine and not to the install, so it collapses to the placeholder's parent.
 */
/** A path as it can appear in raw JSON: literal, and backslash-escaped. */
function pathForms(p: string): string[] {
  return [p, p.replaceAll("\\", "\\\\")];
}

function scrubText(text: string, demoHome: string): string {
  // Both spellings, because this runs over the raw JSON body: a Windows home
  // arrives as C:\\Users\\… with the backslashes escaped, and searching only
  // for the literal path would walk straight past it.
  let out = text;
  for (const form of pathForms(demoHome)) out = out.split(form).join(PLACEHOLDER_HOME);
  for (const form of pathForms(HOME)) out = out.split(form).join("/home/founder");
  return out;
}

// ── the walk ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (PORT === "3030") {
    console.error("Refusing to capture from :3030 — that is the real install on the real ledger.");
    process.exit(1);
  }

  const probe = await fetch(`${API}/workspace`).catch(() => null);
  if (!probe?.ok) {
    console.error(`No API on :${PORT}. Seed and launch a demo home first; see the header comment.`);
    process.exit(1);
  }
  const { current } = (await probe.json()) as { current?: { name: string; home: string } };
  if (current?.name !== "demo") {
    // `demo ui` sets ONESHOT_GTM_WORKSPACE=demo. Anything else on this port is
    // a real workspace, and its ledger has real prospects in it.
    console.error(`:${PORT} is workspace "${current?.name}", not a demo install. Refusing.`);
    process.exit(1);
  }

  const demoHome = current.home;

  await rm(OUT, { recursive: true, force: true });

  const queue = [...SEEDS];
  const seen = new Set<string>();
  let bytes = 0;

  while (queue.length > 0) {
    const url = queue.shift();
    if (url == null || seen.has(url)) continue;
    seen.add(url);

    const res = await fetch(API + url);
    if (!res.ok) {
      console.error(`  ${res.status} ${url}`);
      process.exit(1);
    }

    let body: unknown = JSON.parse(scrubText(await res.text(), demoHome));
    if (url === "/workspace") body = scrubWorkspace(body);

    const file = join(OUT, fixturePath(url));
    await mkdir(dirname(file), { recursive: true });
    const json = JSON.stringify(body);
    await writeFile(file, json);
    bytes += json.length;

    for (const next of expand(url, body)) {
      if (!seen.has(next)) queue.push(next);
    }
  }

  await writeFile(
    join(OUT, "capture.json"),
    JSON.stringify({ capturedAt: new Date().toISOString(), documents: seen.size }, null, 2),
  );

  await guard();

  console.log(`${seen.size} documents, ${(bytes / 1024).toFixed(0)} KB, in ${OUT}`);
}

/**
 * Re-read everything and refuse to ship a home directory.
 *
 * Deliberately not a check on the scrubbing that just ran — it is a check on
 * the tree, which is what actually gets published, and it will keep working
 * when an endpoint starts returning a path that nothing above knows about.
 */
async function guard(): Promise<void> {
  const forbidden: Array<[string, RegExp]> = [
    ["an absolute macOS path", /\/Users\//],
    ["an absolute Linux home", /\/home\/(?!founder\b)[A-Za-z0-9._-]+/],
    // Escaped and unescaped, since the tree on disk is JSON.
    ["an absolute Windows path", /[A-Za-z]:\\{1,2}Users\\{1,2}/],
    ["the operator's home", new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
    ["a named workspace's home", /\.oneshot-gtm-workspaces/],
  ];

  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else files.push(p);
    }
  };
  await walk(OUT);

  let failed = false;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const [what, pattern] of forbidden) {
      const hit = pattern.exec(text);
      if (hit) {
        console.error(`LEAK  ${file.slice(OUT.length + 1)} contains ${what}: ${hit[0]}`);
        failed = true;
      }
    }
  }

  if (failed) {
    await rm(OUT, { recursive: true, force: true });
    console.error(
      "\nFixtures deleted rather than left on disk for someone to vendor. Fix the scrub.",
    );
    process.exit(1);
  }
}

await main();
