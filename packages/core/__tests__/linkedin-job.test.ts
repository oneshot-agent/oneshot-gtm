import { afterEach, describe, expect, it } from "vitest";
import {
  _setLinkedInJobTimingForTests,
  awaitLinkedInJob,
  linkedInError,
  linkedInJobInFlight,
  parseLinkedInRecovery,
  withdrawLinkedInInvite,
  type LinkedInOperation,
} from "../src/index.ts";

// A LinkedIn send is started without waiting and polled with short `wait`
// calls, so no call outlives the cross-workspace worker's limit.

afterEach(() => _setLinkedInJobTimingForTests());

const running = () => Object.assign(new Error("Job timed out"), { name: "JobTimeoutError" });

function poller(answers: Array<unknown | Error>) {
  const ops: LinkedInOperation[] = [];
  return {
    ops,
    call: async (op: LinkedInOperation) => {
      ops.push(op);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("awaitLinkedInJob", () => {
  it("returns a finished answer as it is, without polling", async () => {
    const p = poller([]);
    expect(await awaitLinkedInJob({ status: "sent", invitation_id: "inv-1" }, p.call)).toEqual({
      state: "done",
      result: { status: "sent", invitation_id: "inv-1" },
    });
    expect(p.ops).toEqual([]);
  });

  it("polls an accepted job until it finishes, whatever the result's own status", async () => {
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    // An invite's result can itself read `pending` (the invitation is pending).
    const p = poller([running(), running(), { status: "pending", invitation_id: "inv-1" }]);
    const out = await awaitLinkedInJob({ status: "processing", request_id: "job-1" }, p.call);
    expect(out).toEqual({
      state: "done",
      result: { status: "pending", invitation_id: "inv-1", request_id: "job-1" },
    });
    expect(p.ops).toEqual([
      { kind: "wait", requestId: "job-1" },
      { kind: "wait", requestId: "job-1" },
      { kind: "wait", requestId: "job-1" },
    ]);
  });

  it("is pending at the deadline, and a lost poll is not a failure", async () => {
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    const lost = poller([new Error("LinkedIn workspace worker stopped before returning a result")]);
    expect(await awaitLinkedInJob({ status: "pending", request_id: "job-2" }, lost.call)).toEqual({
      state: "pending",
      requestId: "job-2",
    });
  });

  it("throws a failed job with what it carries", async () => {
    const failed = Object.assign(new Error("Job failed: content_rejected"), {
      name: "JobError",
      code: "content_rejected",
      partialResult: { invitation_id: "inv-x" },
    });
    await expect(
      awaitLinkedInJob({ status: "pending", request_id: "j" }, poller([failed]).call),
    ).rejects.toMatchObject({
      code: "content_rejected",
      partialResult: { invitation_id: "inv-x" },
    });
  });

  it("treats only a pending or processing answer with a request id as in flight", () => {
    expect(linkedInJobInFlight({ status: "processing", request_id: "j" })).toBe("j");
    expect(linkedInJobInFlight({ status: "pending" })).toBeNull();
    expect(linkedInJobInFlight({ status: "sent", request_id: "j" })).toBeNull();
  });
});

describe("withdrawLinkedInInvite", () => {
  it("polls the withdrawal, and throws rather than guess when it is still running", async () => {
    _setLinkedInJobTimingForTests({ pauseMs: 0 });
    const op = {
      kind: "withdraw" as const,
      accountId: "a",
      invitationId: "inv",
      idempotencyKey: "k",
      playName: "luma-events",
    };
    const done = poller([{ status: "processing", request_id: "w" }, { status: "withdrawn" }]);
    expect(await withdrawLinkedInInvite(done.call, op)).toMatchObject({ status: "withdrawn" });
    _setLinkedInJobTimingForTests({ deadlineMs: 0, pauseMs: 0 });
    const slow = poller([{ status: "processing", request_id: "w" }, running()]);
    await expect(withdrawLinkedInInvite(slow.call, op)).rejects.toThrow(/not finished/);
  });
});

describe("parseLinkedInRecovery", () => {
  it("reads the recover endpoint's answers", () => {
    expect(
      parseLinkedInRecovery({
        tool: "linkedin",
        status: "completed",
        linkedin: { action: "message", scheduled_for: "2026-11-03T01:48:21.125Z" },
        receipt_id: "rcpt_1",
        request_id: "660d6a35",
      }),
    ).toEqual({ state: "completed", requestId: "660d6a35", invitationId: null });
    expect(
      parseLinkedInRecovery({
        tool: "linkedin",
        status: "failed",
        linkedin: { action: "invite", invitation_id: "bc05eace" },
        request_id: "5f7e8080",
      }),
    ).toEqual({ state: "failed", requestId: "5f7e8080", invitationId: "bc05eace" });
    // The 404 `submission_not_found`, as the recover operation answers it.
    expect(parseLinkedInRecovery({ status: "unknown", acceptance: "unknown" }).state).toBe(
      "unknown",
    );
    expect(parseLinkedInRecovery({ status: "completed" }).state).toBe("unknown");
  });
});

it("keeps a failed job's partial result across the worker, cleaned", () => {
  const out = linkedInError(
    Object.assign(new Error("Job failed: content_rejected"), {
      name: "JobError",
      code: "content_rejected",
      jobError: "content_rejected",
      partialResult: { invitation_id: "inv-x", nested: { a: 1 }, attempts: 2 },
    }),
  );
  expect(out).toMatchObject({
    name: "JobError",
    code: "content_rejected",
    partialResult: { invitation_id: "inv-x", attempts: 2 },
  });
  expect(out.partialResult).not.toHaveProperty("nested");
});
