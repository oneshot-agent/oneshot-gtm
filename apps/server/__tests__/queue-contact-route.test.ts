import { beforeEach, expect, it, vi } from "vitest";
const { getRow, update, lookup } = vi.hoisted(() => ({
  getRow: vi.fn(),
  update: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ({ getQueueRow: getRow, updateQueuePayload: update }),
}));
vi.mock("@oneshot-gtm/find", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find")),
  resolveQueueContact: lookup,
  resolveQueueTarget: (row: { payload_json: string }) => ({
    ...JSON.parse(row.payload_json),
    yourEdge: "current edge",
  }),
}));
const { resolveQueueContactRoute } = await import("../src/api/queue-contact.ts");
const row = {
  id: 9,
  status: "approved",
  send_started_at: null,
  payload_json: JSON.stringify({ name: "A Founder" }),
};
const request = () =>
  resolveQueueContactRoute(
    new Request("http://localhost/api/queue/9/resolve-contact", { method: "POST" }),
    { id: "9" },
  );
beforeEach(() => {
  vi.resetAllMocks();
  getRow.mockReturnValue(row);
  lookup.mockResolvedValue({ email: "verified@example.com" });
});
it("persists the verified contact and returns the current edge without overwriting historical edges", async () => {
  const res = await request();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    payload: { name: "A Founder", email: "verified@example.com", yourEdge: "current edge" },
  });
  expect(update).toHaveBeenCalledWith({
    id: 9,
    payload: { name: "A Founder", email: "verified@example.com" },
  });
});
it.each(["sent", "pending", "rejected"])("does not buy lookup for a %s row", async (status) => {
  getRow.mockReturnValue({ ...row, status });
  expect((await request()).status).toBe(409);
  expect(lookup).not.toHaveBeenCalled();
});
it("does not overwrite a row edited during lookup", async () => {
  getRow
    .mockReturnValueOnce(row)
    .mockReturnValue({ ...row, payload_json: '{"email":"edited@example.com"}' });
  expect((await request()).status).toBe(409);
  expect(update).not.toHaveBeenCalled();
});
it("leaves the row untouched on lookup failure", async () => {
  lookup.mockRejectedValue(new Error("No verified email"));
  expect((await request()).status).toBe(422);
  expect(update).not.toHaveBeenCalled();
});
it("prevents overlapping lookups of the same row", async () => {
  let finish!: (value: Record<string, string>) => void;
  lookup.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = request();
  expect((await request()).status).toBe(409);
  finish({ email: "verified@example.com" });
  expect((await first).status).toBe(200);
  expect(lookup).toHaveBeenCalledTimes(1);
});
