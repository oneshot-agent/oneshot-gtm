import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLedger, RunCancelledError } from "@oneshot-gtm/core";
import type { RunPlayEvent } from "@oneshot-gtm/shared-types";

interface VerifyResult<T> {
  verified: T[];
  dropped: Array<{ target: T; email: string; reason: string }>;
  receiptIds: number[];
  costUsd: number;
}

let nextVerify: VerifyResult<unknown> = {
  verified: [],
  dropped: [],
  receiptIds: [],
  costUsd: 0,
};
let captureVerifyArgs: { targets: unknown[]; playName: string; dryRun: boolean } | null = null;

const playCalls: { name: string; targets: unknown[] }[] = [];

interface FakeDraft {
  subject: string;
  body: string;
  flags: string[];
  sent: boolean;
  receiptIds: number[];
}
type FakeRunInput = {
  targets: unknown[];
  onProgress?: (index: number, draft: FakeDraft) => void;
};
/**
 * Per-test override for the fake play's `run`, so a test can model what the
 * happy-path fake can't: a play that rejects (cancelled, or plainly broken)
 * while one of its workers is still in flight.
 */
let runOverride: ((input: FakeRunInput) => Promise<{ drafted: unknown[] }>) | null = null;

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");

  // Dispatch routes through PLAYS[name].run, so override the registry (not the
  // individual run* exports) to capture calls without hitting the real SDK.
  // Mirrors `runEmailPlay`: fires `onProgress(index, draft)` for each drafted
  // row before resolving — so the SSE handler's per-target draft/send events
  // exercise the same callback path they do in production.
  const fakeRun =
    (name: string) =>
    async (input: {
      targets: unknown[];
      onProgress?: (
        index: number,
        draft: {
          subject: string;
          body: string;
          flags: string[];
          sent: boolean;
          receiptIds: number[];
        },
      ) => void;
    }) => {
      playCalls.push({ name, targets: input.targets });
      if (runOverride) return runOverride(input);
      if (name === "show-hn") {
        const drafted = input.targets.map((_, i) => ({
          target: { postTitle: `t${i}` },
          subject: `subj-${i}`,
          body: `body-${i}`,
          flags: [],
          receiptIds: [100 + i],
          sent: false,
        }));
        if (input.onProgress) {
          drafted.forEach((d, i) => input.onProgress?.(i, d));
        }
        return { drafted };
      }
      return { drafted: [] };
    };

  const names = [
    "show-hn",
    "job-change",
    "post-funding",
    "accelerator-batch",
    "hiring-signal",
    "podcast-guest",
    "competitor-switch",
    "stack-consolidation",
    "breakup-revive",
  ];
  const PLAYS: Record<string, { run: ReturnType<typeof fakeRun> }> = {};
  for (const n of names) PLAYS[n] = { run: fakeRun(n) };

  return {
    ...actual,
    PLAYS,
    isSupportedPlay: (name: string) => Object.prototype.hasOwnProperty.call(PLAYS, name),
    verifyAndFilterTargets: async (
      targets: unknown[],
      _getEmail: (t: unknown) => string,
      opts: { playName: string; dryRun: boolean },
    ) => {
      captureVerifyArgs = { targets, playName: opts.playName, dryRun: opts.dryRun };
      return nextVerify;
    },
  };
});

const { runPlay } = await import("../src/api/run.ts");

function makeRequest(playName: string, body: unknown, signal?: AbortSignal): Request {
  return new Request(`http://127.0.0.1:3030/api/run/${playName}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3030" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

async function readSseFrames(stream: ReadableStream<Uint8Array> | null): Promise<RunPlayEvent[]> {
  if (!stream) return [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: RunPlayEvent[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const block of events) {
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (data) frames.push(JSON.parse(data) as RunPlayEvent);
    }
  }
  return frames;
}

beforeEach(() => {
  nextVerify = { verified: [], dropped: [], receiptIds: [], costUsd: 0 };
  captureVerifyArgs = null;
  playCalls.length = 0;
  runOverride = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runPlay — verify-then-dispatch", () => {
  it("calls verifyAndFilterTargets with the right playName + dryRun before dispatching", async () => {
    const targets = [{ founderEmail: "a@x.dev", postTitle: "T1" }];
    nextVerify = { verified: targets, dropped: [], receiptIds: [], costUsd: 0 };
    const res = await runPlay(makeRequest("show-hn", { targets, dryRun: true }), {
      playName: "show-hn",
    });
    await readSseFrames(res.body);
    expect(captureVerifyArgs).toEqual({ targets, playName: "show-hn", dryRun: true });
    expect(playCalls).toHaveLength(1);
    expect(playCalls[0]?.name).toBe("show-hn");
  });

  it("does NOT emit a verify event when nothing was dropped", async () => {
    const targets = [{ founderEmail: "a@x.dev" }, { founderEmail: "b@x.dev" }];
    nextVerify = { verified: targets, dropped: [], receiptIds: [101, 102], costUsd: 0.01 };
    const res = await runPlay(makeRequest("show-hn", { targets, dryRun: false }), {
      playName: "show-hn",
    });
    const frames = await readSseFrames(res.body);
    expect(frames.find((f) => f.kind === "verify")).toBeUndefined();
    // dispatchPlay was still invoked, with the verified targets.
    expect(playCalls[0]?.targets).toEqual(targets);
  });

  it("emits a verify event when at least one target was dropped + only forwards verified targets", async () => {
    const targets = [
      { email: "good@x.dev", company: "Good" },
      { email: "bad@y.dev", company: "Bad" },
    ];
    nextVerify = {
      verified: [targets[0]!],
      dropped: [{ target: targets[1]!, email: "bad@y.dev", reason: "undeliverable" }],
      receiptIds: [201, 202],
      costUsd: 0.02,
    };
    const res = await runPlay(makeRequest("post-funding", { targets, dryRun: false }), {
      playName: "post-funding",
    });
    const frames = await readSseFrames(res.body);
    const verifyFrame = frames.find((f) => f.kind === "verify");
    expect(verifyFrame).toMatchObject({
      kind: "verify",
      total: 2,
      verified: 1,
      dropped: [{ email: "bad@y.dev", reason: "undeliverable" }],
    });
    // Play was called with only the good target.
    expect(playCalls[0]?.targets).toEqual([targets[0]]);
  });

  it("short-circuits dispatch when ALL targets are dropped — emits done(0,0) without calling the play", async () => {
    const targets = [
      { email: "bad1@x.dev", company: "B1" },
      { email: "bad2@y.dev", company: "B2" },
    ];
    nextVerify = {
      verified: [],
      dropped: [
        { target: targets[0]!, email: "bad1@x.dev", reason: "undeliverable" },
        { target: targets[1]!, email: "bad2@y.dev", reason: "undeliverable" },
      ],
      receiptIds: [301, 302],
      costUsd: 0.02,
    };
    const res = await runPlay(makeRequest("post-funding", { targets, dryRun: false }), {
      playName: "post-funding",
    });
    const frames = await readSseFrames(res.body);
    expect(playCalls).toHaveLength(0); // dispatch skipped
    expect(frames.find((f) => f.kind === "verify")).toBeDefined();
    const done = frames.find((f) => f.kind === "done");
    expect(done).toMatchObject({ kind: "done", total: 0, sent: 0 });
    // No draft/send frames for the dropped targets.
    expect(frames.filter((f) => f.kind === "draft")).toHaveLength(0);
  });

  it("emits one draft + one send SSE frame per target as onProgress fires", async () => {
    // Two verified targets → fakeRun fires onProgress(0,...) then onProgress(1,...).
    // The SSE handler's callback should turn each into a `draft` event AND
    // (since receiptIds is non-empty) a `send` event, both with the right index.
    const targets = [
      { founderEmail: "a@x.dev", postTitle: "T0" },
      { founderEmail: "b@x.dev", postTitle: "T1" },
    ];
    nextVerify = { verified: targets, dropped: [], receiptIds: [], costUsd: 0 };
    const res = await runPlay(makeRequest("show-hn", { targets, dryRun: false }), {
      playName: "show-hn",
    });
    const frames = await readSseFrames(res.body);
    const drafts = frames.filter((f) => f.kind === "draft");
    const sends = frames.filter((f) => f.kind === "send");
    expect(drafts).toHaveLength(2);
    expect(sends).toHaveLength(2);
    expect(drafts.map((f) => (f as { index: number }).index)).toEqual([0, 1]);
    expect(sends.map((f) => (f as { index: number }).index)).toEqual([0, 1]);
    const done = frames.find((f) => f.kind === "done");
    expect(done).toMatchObject({ kind: "done", total: 2 });
  });

  it("records a send reported after the cancel already wrote the row", async () => {
    // The play's Promise.all rejects on the first cancelled worker while a
    // sibling is still inside sendDraftedEmail. That sibling's email left and
    // enrolled in a cadence, so it has to reach prospect_emails_json even
    // though it lands after the terminal write — /cadences?sinceRun reads it.
    const targets = [{ founderEmail: "a@x.dev" }, { founderEmail: "b@x.dev" }];
    nextVerify = { verified: targets, dropped: [], receiptIds: [], costUsd: 0 };
    const straggler: { fire: () => void } = { fire: () => {} };
    const draft = (i: number): FakeDraft => ({
      subject: `subj-${i}`,
      body: `body-${i}`,
      flags: [],
      sent: true,
      receiptIds: [100 + i],
    });
    runOverride = (input) => {
      input.onProgress?.(0, draft(0));
      straggler.fire = () => input.onProgress?.(1, draft(1));
      return Promise.reject(new RunCancelledError("show-hn send: cancelled by user"));
    };
    const res = await runPlay(makeRequest("show-hn", { targets, dryRun: false }), {
      playName: "show-hn",
    });
    const frames = await readSseFrames(res.body);
    const started = frames.find((f) => f.kind === "runStarted") as { runId: number };
    expect(frames.find((f) => f.kind === "cancelled")).toBeDefined();
    // The stream is closed — i.e. the terminal ledger write already happened.
    straggler.fire();
    const row = getLedger().getRun(started.runId);
    expect(row?.status).toBe("cancelled");
    expect(row?.prospectEmails).toEqual(["a@x.dev", "b@x.dev"]);
  });

  it("reports a real error as an error even when the client already disconnected", async () => {
    // Disconnect fires the run's abort, but what actually ended the run was an
    // SDK failure — it must land as `error`, not get relabelled a cancellation.
    const targets = [{ founderEmail: "a@x.dev" }];
    nextVerify = { verified: targets, dropped: [], receiptIds: [], costUsd: 0 };
    const clientGone = new AbortController();
    runOverride = () => {
      clientGone.abort("client disconnected");
      return Promise.reject(new Error("SDK exploded"));
    };
    const res = await runPlay(
      makeRequest("show-hn", { targets, dryRun: false }, clientGone.signal),
      { playName: "show-hn" },
    );
    const frames = await readSseFrames(res.body);
    const started = frames.find((f) => f.kind === "runStarted") as { runId: number };
    expect(frames.find((f) => f.kind === "error")).toMatchObject({ message: "SDK exploded" });
    expect(frames.find((f) => f.kind === "cancelled")).toBeUndefined();
    expect(getLedger().getRun(started.runId)?.status).not.toBe("cancelled");
  });

  it("returns 400 when playName is not in SUPPORTED", async () => {
    const res = await runPlay(makeRequest("nope", { targets: [{}] }), { playName: "nope" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("not exposed");
  });

  it("returns 400 when targets is missing or empty", async () => {
    const empty = await runPlay(makeRequest("show-hn", { targets: [], dryRun: true }), {
      playName: "show-hn",
    });
    expect(empty.status).toBe(400);
    const noTargets = await runPlay(makeRequest("show-hn", { dryRun: true }), {
      playName: "show-hn",
    });
    expect(noTargets.status).toBe(400);
  });
});
