import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    verifyAndFilterTargets: async (
      targets: unknown[],
      _getEmail: (t: unknown) => string,
      opts: { playName: string; dryRun: boolean },
    ) => {
      captureVerifyArgs = { targets, playName: opts.playName, dryRun: opts.dryRun };
      return nextVerify;
    },
    runShowHn: async (input: { targets: unknown[] }) => {
      playCalls.push({ name: "show-hn", targets: input.targets });
      return {
        drafted: input.targets.map((_, i) => ({
          target: { postTitle: `t${i}` },
          subject: `subj-${i}`,
          body: `body-${i}`,
          flags: [],
          receiptIds: [100 + i],
          sent: false,
        })),
      };
    },
    runJobChange: async (input: { targets: unknown[] }) => {
      playCalls.push({ name: "job-change", targets: input.targets });
      return { drafted: [] };
    },
    runPostFunding: async (input: { targets: unknown[] }) => {
      playCalls.push({ name: "post-funding", targets: input.targets });
      return { drafted: [] };
    },
    runAcceleratorBatch: async (input: { targets: unknown[] }) => {
      playCalls.push({ name: "accelerator-batch", targets: input.targets });
      return { drafted: [] };
    },
    runHiringSignal: async (input: { targets: unknown[] }) => {
      playCalls.push({ name: "hiring-signal", targets: input.targets });
      return { drafted: [] };
    },
    runPodcastGuest: async (input: { targets: unknown[] }) => {
      playCalls.push({ name: "podcast-guest", targets: input.targets });
      return { drafted: [] };
    },
    runCompetitorSwitch: async (input: { targets: unknown[] }) => {
      playCalls.push({ name: "competitor-switch", targets: input.targets });
      return { drafted: [] };
    },
  };
});

const { runPlay } = await import("../src/api/run.ts");

function makeRequest(playName: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:3030/api/run/${playName}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3030" },
    body: JSON.stringify(body),
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
