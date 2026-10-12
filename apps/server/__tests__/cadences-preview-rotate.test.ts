import { beforeEach, expect, it, vi } from "vitest";

const previewMock = vi.fn(async (_input: unknown) => ({
  subject: "s",
  body: "b",
  flags: [],
  draftedAt: "now",
  stepLabel: "follow-up",
  isBreakup: false,
}));

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return { ...actual, previewCadenceStep: (input: unknown) => previewMock(input) };
});

const { previewCadenceStepRoute } = await import("../src/api/cadences.ts");

function req(body?: unknown): Request {
  return new Request("http://localhost/api/cadences/7/preview-next?play=luma-events", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

beforeEach(() => previewMock.mockClear());

it("passes rotateAngle through, and a bare request is a plain regenerate", async () => {
  expect((await previewCadenceStepRoute(req({ rotateAngle: true }), { id: "7" })).status).toBe(200);
  expect(previewMock).toHaveBeenLastCalledWith({
    prospectId: 7,
    playName: "luma-events",
    rotateAngle: true,
    linkedIn: expect.any(Function),
  });
  expect((await previewCadenceStepRoute(req(), { id: "7" })).status).toBe(200);
  expect(previewMock).toHaveBeenLastCalledWith({
    prospectId: 7,
    playName: "luma-events",
    rotateAngle: false,
    linkedIn: expect.any(Function),
  });
});

it("answers 200 with the waiting message, not a 500, before acceptance", async () => {
  previewMock.mockResolvedValueOnce({
    waiting: true,
    since: "2026-10-01",
    message: "waiting for acceptance since 2026-10-01",
  } as never);
  const res = await previewCadenceStepRoute(req(), { id: "7" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    waiting: true,
    since: "2026-10-01",
    message: "waiting for acceptance since 2026-10-01",
  });
});

it("rejects a non-boolean rotateAngle and a non-JSON body", async () => {
  expect((await previewCadenceStepRoute(req({ rotateAngle: "yes" }), { id: "7" })).status).toBe(
    400,
  );
  expect((await previewCadenceStepRoute(req("{"), { id: "7" })).status).toBe(400);
  expect(previewMock).not.toHaveBeenCalled();
});
