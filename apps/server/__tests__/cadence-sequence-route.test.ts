import { describe, expect, it, vi } from "vitest";
import type { CadenceSequenceView } from "@oneshot-gtm/shared-types";

// GET /api/cadences/:id/sequence: the plays read, behind the usual id + play checks.

const sequenceMock = vi.fn<(prospectId: number, playName: string) => CadenceSequenceView | null>();

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return { ...actual, cadenceSequence: sequenceMock };
});

const { cadenceSequenceRoute } = await import("../src/api/cadences.ts");

const req = (path: string) =>
  new Request(`http://localhost${path}`, {
    headers: { host: "127.0.0.1:3030" },
  });

describe("cadence sequence route", () => {
  it("returns the sequence for the prospect and play", async () => {
    const view: CadenceSequenceView = {
      linkedInSent: [
        {
          stepIndex: 3,
          label: "connection request",
          text: "hey",
          sentAt: "2026-10-27T03:43:21Z",
        },
      ],
      invite: { sentOn: "2026-10-27", expiresOn: "2026-11-17" },
      upcoming: [],
    };
    sequenceMock.mockReturnValue(view);
    const res = cadenceSequenceRoute(req("/api/cadences/7/sequence?play=accelerator-batch"), {
      id: "7",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect(sequenceMock).toHaveBeenLastCalledWith(7, "accelerator-batch");
  });

  it("404 when there is no such cadence", () => {
    sequenceMock.mockReturnValue(null);
    const res = cadenceSequenceRoute(req("/api/cadences/7/sequence?play=x"), {
      id: "7",
    });
    expect(res.status).toBe(404);
  });

  it("400 without a play", () => {
    const res = cadenceSequenceRoute(req("/api/cadences/7/sequence"), {
      id: "7",
    });
    expect(res.status).toBe(400);
  });
});
