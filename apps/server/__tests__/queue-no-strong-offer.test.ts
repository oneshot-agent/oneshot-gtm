import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// A pending row whose offer writer found no strong offer (`payload.offerSkip`,
// no `payload.offer`) leaves the pending review list: GET /api/queue with
// `offerSkip=exclude` drops it, `offerSkip=only` lists it, the response counts
// it, and "Approve pending" leaves it pending. Real ledger.

let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  logEvent: () => {},
}));
vi.mock("@oneshot-gtm/find", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find")),
  scheduleNewsfeedOnApproval: () => {},
}));

const { listQueueRoute, approveAllRoute } = await import("../src/api/queue.ts");

const PLAY = "queue-no-strong-offer-play";

const skip = {
  why: "Nothing in their work fits the product closely enough.",
  version: "offer-v9",
  inputHash: "in-hash",
  productHash: "product-hash",
  skippedAt: "2026-10-28T09:00:00.000Z",
};
const offer = { offer: "A one-week audit of the Harbor Tiles checkout.", steps: "We run it." };

let n = 0;
function pendingRow(payload: Record<string, unknown>, play = PLAY): number {
  const key = `k-${++n}`;
  return ledger.enqueueTarget({
    playName: play,
    payload: { name: "Priya Halvorsen", email: `priya${n}@harbortiles.example`, ...payload },
    dedupeKey: key,
    source: "find:test",
  })!;
}

async function list(query: string): Promise<{ ids: number[]; noStrongOffer: number }> {
  const res = listQueueRoute(new Request(`http://localhost/api/queue?${query}`));
  const body = (await res.json()) as { rows: Array<{ id: number }>; noStrongOffer: number };
  return {
    ids: body.rows.map((r) => r.id).toSorted((a, b) => a - b),
    noStrongOffer: body.noStrongOffer,
  };
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
});

describe("pending rows with no strong offer", () => {
  it("leave the pending review list, list on their own, and are counted", async () => {
    const skipped = pendingRow({ offerSkip: skip });
    const withOffer = pendingRow({ offer });
    // A skip the row kept beside a usable offer does not hold it.
    const both = pendingRow({ offer, offerSkip: skip });
    const plain = pendingRow({});
    // A malformed skip is not the writer's decline.
    const badSkip = pendingRow({ offerSkip: { why: "no hashes" } });
    // A play that makes no offer never has a missing one.
    const survey = pendingRow({ offerSkip: skip }, "pmf-survey");
    // A blank offer is no offer.
    const blank = pendingRow({ offer: { offer: "  \n", steps: "x" }, offerSkip: skip });

    const review = await list("status=pending&offerSkip=exclude");
    expect(review.ids).toEqual([withOffer, both, plain, badSkip, survey]);
    expect(review.noStrongOffer).toBe(2);

    expect((await list("status=pending&offerSkip=only")).ids).toEqual([skipped, blank]);
    // Without the flag the pending list is as it was.
    expect((await list("status=pending")).ids).toEqual([
      skipped,
      withOffer,
      both,
      plain,
      badSkip,
      survey,
      blank,
    ]);
  });

  it("only splits the pending list: other statuses and id picks ignore the flag", async () => {
    const skipped = pendingRow({ offerSkip: skip });
    const rejected = pendingRow({ offerSkip: skip });
    ledger.setQueueStatus({ id: rejected, status: "rejected" });

    expect((await list("status=rejected&offerSkip=exclude")).ids).toEqual([rejected]);
    expect((await list(`ids=${skipped}&offerSkip=exclude`)).ids).toEqual([skipped]);
    // The count is pending rows only.
    expect((await list("status=rejected")).noStrongOffer).toBe(1);
  });

  it("keeps the ranked review order's window free of them", async () => {
    pendingRow({ offerSkip: skip });
    const withOffer = pendingRow({ offer });
    expect((await list("status=pending&offerSkip=exclude&order=ranked")).ids).toEqual([withOffer]);
  });

  it("stay pending when every pending row is approved, and the count says so", async () => {
    const skipped = pendingRow({ offerSkip: skip });
    const withOffer = pendingRow({ offer });
    const res = await approveAllRoute(
      new Request("http://localhost/api/queue/approve-all", { method: "POST", body: "{}" }),
    );
    expect(await res.json()).toEqual({ approved: 1 });
    expect(ledger.getQueueRow(skipped)?.status).toBe("pending");
    expect(ledger.getQueueRow(withOffer)?.status).toBe("approved");
  });

  it("stay pending when one play's pending rows are approved", async () => {
    const skipped = pendingRow({ offerSkip: skip });
    const withOffer = pendingRow({ offer });
    const other = pendingRow({ offer }, "another-offer-play");
    const res = await approveAllRoute(
      new Request("http://localhost/api/queue/approve-all", {
        method: "POST",
        body: JSON.stringify({ play: PLAY }),
      }),
    );
    expect(await res.json()).toEqual({ approved: 1 });
    expect(ledger.getQueueRow(skipped)?.status).toBe("pending");
    expect(ledger.getQueueRow(withOffer)?.status).toBe("approved");
    expect(ledger.getQueueRow(other)?.status).toBe("pending");
  });
});
