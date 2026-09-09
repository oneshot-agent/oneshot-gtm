import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #610: skipping a cadence's direct-mail step from /cadences. The route
// carries stop's gates (bad id, missing play, not found, not active, send in
// flight) plus two of its own: the next step must be a letter, and a mailpiece
// already submitted to the printer is recovered in the mail review, not
// skipped here. The batch is sequential and per-item.

const getCadenceMock = vi.fn();
const findDirectMailMock = vi.fn();
const skipMock = vi.fn();
const nextStepInfoMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({ getCadence: getCadenceMock, findDirectMail: findDirectMailMock }),
  };
});

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    skipDirectMailStep: (...args: unknown[]) => skipMock(...args),
    nextStepInfo: (...args: unknown[]) => nextStepInfoMock(...args),
  };
});

const { skipCadenceMailRoute, skipCadenceMailBatchRoute } = await import("../src/api/cadences.ts");

const active = {
  status: "active",
  sending_started_at: null,
  current_step: 1,
  enrolled_at: "2026-09-01 10:00:00",
};

function request(play = "post-funding", id = "7"): Request {
  return new Request(`http://localhost/api/cadences/${id}/skip-mail?play=${play}`, {
    method: "POST",
    headers: { host: "127.0.0.1:3030" },
  });
}

describe("skipCadenceMailRoute", () => {
  beforeEach(() => {
    getCadenceMock.mockReset();
    getCadenceMock.mockReturnValue(active);
    findDirectMailMock.mockReset();
    findDirectMailMock.mockReturnValue(null);
    skipMock.mockReset();
    nextStepInfoMock.mockReset();
    nextStepInfoMock.mockReturnValue({
      label: "Direct mail",
      isBreakup: false,
      channel: "direct_mail",
    });
  });

  it("skips a pending letter and reports where the cadence stands", async () => {
    getCadenceMock.mockReturnValueOnce(active).mockReturnValueOnce({ ...active, current_step: 2 });
    nextStepInfoMock
      .mockReturnValueOnce({ label: "Direct mail", isBreakup: false, channel: "direct_mail" })
      .mockReturnValueOnce({ label: "case-study follow-up", isBreakup: false, channel: "email" });
    const res = skipCadenceMailRoute(request(), { id: "7" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      currentStep: 2,
      status: "active",
      nextStepChannel: "email",
    });
    expect(skipMock).toHaveBeenCalledWith({ prospectId: 7, playName: "post-funding" });
  });

  it("requires an id and a play", () => {
    expect(skipCadenceMailRoute(request("post-funding", "x"), { id: "x" }).status).toBe(400);
    expect(skipCadenceMailRoute(request(""), { id: "7" }).status).toBe(400);
    expect(skipMock).not.toHaveBeenCalled();
  });

  it("404s an unknown cadence and 409s one that is not active or is mid-send", async () => {
    getCadenceMock.mockReturnValueOnce(null);
    expect(skipCadenceMailRoute(request(), { id: "7" }).status).toBe(404);
    getCadenceMock.mockReturnValueOnce({ ...active, status: "stopped" });
    const stopped = skipCadenceMailRoute(request(), { id: "7" });
    expect(stopped.status).toBe(409);
    expect((await stopped.json()).error).toContain("already stopped");
    getCadenceMock.mockReturnValueOnce({ ...active, sending_started_at: "2026-09-09 10:00:00" });
    expect(skipCadenceMailRoute(request(), { id: "7" }).status).toBe(409);
    expect(skipMock).not.toHaveBeenCalled();
  });

  it("refuses when the next step is an email, and when the mailpiece was already submitted", async () => {
    nextStepInfoMock.mockReturnValueOnce({
      label: "value follow-up",
      isBreakup: false,
      channel: "email",
    });
    const notLetter = skipCadenceMailRoute(request(), { id: "7" });
    expect(notLetter.status).toBe(409);
    expect((await notLetter.json()).error).toContain("not a letter");
    findDirectMailMock.mockReturnValueOnce({ id: "m1", started: true });
    const started = skipCadenceMailRoute(request(), { id: "7" });
    expect(started.status).toBe(409);
    expect((await started.json()).error).toContain("recover");
    expect(skipMock).not.toHaveBeenCalled();
  });

  it("a drafted-but-unsent mailpiece counts as a letter even if the plan says email", () => {
    nextStepInfoMock.mockReturnValueOnce({
      label: "value follow-up",
      isBreakup: false,
      channel: "email",
    });
    findDirectMailMock.mockReturnValueOnce({ id: "m1", started: false });
    expect(skipCadenceMailRoute(request(), { id: "7" }).status).toBe(200);
    expect(skipMock).toHaveBeenCalledTimes(1);
  });

  it("turns the engine's own refusal into a 409 with its message", async () => {
    skipMock.mockImplementationOnce(() => {
      throw new Error("No pending mail step to skip");
    });
    const res = skipCadenceMailRoute(request(), { id: "7" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("No pending mail step to skip");
  });
});

describe("skipCadenceMailBatchRoute", () => {
  beforeEach(() => {
    skipMock.mockReset();
  });

  const batch = (body: unknown): Request =>
    new Request("http://localhost/api/cadences/skip-mail-batch", {
      method: "POST",
      headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
      body: JSON.stringify(body),
    });

  it("skips each item on its own and reports the ones it could not", async () => {
    skipMock.mockImplementation((item: { prospectId: number }) => {
      if (item.prospectId === 2)
        throw new Error("Recover the submitted mailpiece before continuing");
    });
    const res = await skipCadenceMailBatchRoute(
      batch({
        items: [
          { prospectId: 1, playName: "post-funding" },
          { prospectId: 2, playName: "post-funding" },
          { prospectId: 3, playName: "hiring-signal" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { prospectId: 1, playName: "post-funding", ok: true },
        {
          prospectId: 2,
          playName: "post-funding",
          ok: false,
          error: "Recover the submitted mailpiece before continuing",
        },
        { prospectId: 3, playName: "hiring-signal", ok: true },
      ],
      skipped: 2,
      failed: 1,
    });
    expect(skipMock).toHaveBeenCalledTimes(3);
  });

  it("rejects an empty or malformed item list", async () => {
    expect((await skipCadenceMailBatchRoute(batch({ items: [] }))).status).toBe(400);
    expect((await skipCadenceMailBatchRoute(batch({}))).status).toBe(400);
    expect(skipMock).not.toHaveBeenCalled();
  });
});
