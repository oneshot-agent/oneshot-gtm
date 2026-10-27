import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.ts";
import { QUEUE_POLL_MS, rowDetailQuery } from "../src/routes/queue.tsx";

// Issue #929: the list carries a trimmed payload and the open row reads its
// full JSON from the row-detail route. That read must follow the polled list:
// a poll that changes the row reads the detail again, with the previous JSON
// held until the new one lands; a poll that changes nothing reads nothing.

/** The row-detail route as the page sees it: `payload` is whatever the store holds now. */
let storedPayload: Record<string, unknown> = {};
const detailReads = vi.fn(async (id: number) => ({
  row: { id, payload: storedPayload },
}));
vi.spyOn(api, "queueRowDetail").mockImplementation(
  detailReads as unknown as typeof api.queueRowDetail,
);

const baseRow = {
  id: 7,
  playName: "luma-events",
  channel: "email",
  sender: "api",
  payload: { name: "Ada", email: "ada@example.com" },
  dedupeKey: "luma:ada",
  source: "luma",
  status: "pending",
  foundAt: "2026-10-01T00:00:00.000Z",
  reviewedAt: null,
  sentAt: null,
  notes: null,
} as unknown as QueueRowView;

let client: QueryClient;
let observer: ReturnType<typeof observe>;
let unsubscribe: () => void;

/** The page's hook, headless: the observer `useQuery` would create for the open row. */
function observe(row: QueueRowView) {
  return new QueryObserver(client, rowDetailQuery(row));
}

/** Wait until the observer's current result has data and is no longer fetching. */
async function settled() {
  await vi.waitFor(() => {
    const r = observer.getCurrentResult();
    expect(r.isFetching).toBe(false);
    expect(r.data).toBeDefined();
  });
  return observer.getCurrentResult();
}

beforeEach(() => {
  storedPayload = { name: "Ada", email: "ada@example.com", dossier: "v1" };
  detailReads.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  observer = observe(baseRow);
  unsubscribe = observer.subscribe(() => {});
});
afterEach(() => {
  unsubscribe();
  client.clear();
});

describe("rowDetailQuery (#929)", () => {
  it("reads the detail once for the open row, and not again for a poll that changed nothing", async () => {
    expect((await settled()).data?.row.payload).toEqual(storedPayload);
    expect(detailReads).toHaveBeenCalledTimes(1);

    // The next poll hands the row down as a new object with the same content.
    observer.setOptions(
      rowDetailQuery({ ...baseRow, payload: { ...(baseRow.payload as object) } }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(detailReads).toHaveBeenCalledTimes(1);
  });

  it("reads the detail again when a poll changes the row, holding the old JSON until the new one lands", async () => {
    const first = await settled();
    expect(first.data?.row.payload).toEqual({
      name: "Ada",
      email: "ada@example.com",
      dossier: "v1",
    });

    // A worker researched the person: the store changed and the list now shows it.
    storedPayload = { ...storedPayload, dossier: "v2", personResearch: { status: "complete" } };
    observer.setOptions(
      rowDetailQuery({
        ...baseRow,
        payload: { ...(baseRow.payload as object), personResearch: { status: "complete" } },
      }),
    );
    const during = observer.getCurrentResult();
    expect(during.isPlaceholderData).toBe(true);
    expect(during.data?.row.payload).toEqual(first.data?.row.payload);

    const after = await settled();
    expect(detailReads).toHaveBeenCalledTimes(2);
    expect(after.isPlaceholderData).toBe(false);
    expect(after.data?.row.payload).toEqual(storedPayload);
  });

  it("polls the open row at the list's cadence, for changes the trimmed list cannot show", () => {
    expect(rowDetailQuery(baseRow).refetchInterval).toBe(QUEUE_POLL_MS);
    expect(QUEUE_POLL_MS).toBe(20_000);
  });
});
