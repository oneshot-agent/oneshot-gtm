import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLedger, loadConfig, saveConfig } from "@oneshot-gtm/core";

// A queue draft is stamped with the config it was written under. On /queue
// one written under another setup (or before drafts carried a key) reads
// stale, and Send ships it only when the founder confirms. Real ledger in the
// per-file temp home; only the send itself is faked.

const sends: unknown[] = [];

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    sendDraftedEmail: async (opts: unknown) => {
      sends.push(opts);
      return { sent: true, receiptIds: [] };
    },
  };
});
vi.mock("../src/telemetry.ts", () => ({ reportServerExecution: () => {} }));

const { listQueueRoute, sendDraftRoute } = await import("../src/api/queue.ts");
const { queueDraftConfigKey } = await import("@oneshot-gtm/plays");

const PLAY = "show-hn";
let n = 0;

/** An approved email row with a reviewed draft, stamped with `configKey` when given. */
function approvedRow(configKey?: string): number {
  const ledger = getLedger();
  const id = ledger.enqueueTarget({
    playName: PLAY,
    payload: { name: "Sam Example", email: `sam${++n}@example.test`, company: "Example Co" },
    dedupeKey: `stale-${n}`,
    source: "find:test",
  })!;
  ledger.setQueueDraft({
    id,
    draft: {
      subject: "routes",
      body: "A reviewed draft.",
      flags: [],
      sent: false,
      receiptIds: [],
      dryRun: true,
      ...(configKey ? { configKey } : {}),
    },
  });
  ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
  return id;
}

async function listed(id: number): Promise<{ stale?: boolean } | null> {
  const res = await listQueueRoute(new Request("http://localhost/api/queue?status=approved"));
  const body = (await res.json()) as {
    rows: Array<{ id: number; lastDraft: { stale?: boolean } | null }>;
  };
  return body.rows.find((r) => r.id === id)?.lastDraft ?? null;
}

const send = (id: number, body?: unknown) =>
  sendDraftRoute(
    new Request(`http://localhost/api/queue/${id}/send-draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { id: String(id) },
  );

beforeEach(() => {
  sends.length = 0;
  saveConfig({ ...loadConfig(), founderAdmission: "a fictional concession" });
});

describe("a queue draft and the config it was written under", () => {
  it("reads stale with no key or another key, never with today's", async () => {
    const current = approvedRow(queueDraftConfigKey(PLAY, "email"));
    const keyless = approvedRow();
    const other = approvedRow("0ld0ld0ld0ld");
    expect((await listed(current))?.stale).toBeUndefined();
    expect((await listed(keyless))?.stale).toBe(true);
    expect((await listed(other))?.stale).toBe(true);
  });

  it("turns stale once the setup changes", async () => {
    const id = approvedRow(queueDraftConfigKey(PLAY, "email"));
    saveConfig({ ...loadConfig(), offerExclusions: ["a fictional kind of goal"] });
    expect((await listed(id))?.stale).toBe(true);
  });

  it("Send refuses a stale draft with 409 stale, and sends it once the founder confirms", async () => {
    const id = approvedRow();
    const refused = await send(id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      stale: true,
      error: "stale-config: draft written under an older setup; re-preview",
    });
    expect(sends).toEqual([]);
    expect(getLedger().getQueueRow(id)?.send_started_at).toBeNull();

    const sent = await send(id, { confirmStale: true });
    expect(sent.status).toBe(200);
    expect(sends).toHaveLength(1);
  });

  it("Send ships a current draft without asking", async () => {
    const id = approvedRow(queueDraftConfigKey(PLAY, "email"));
    expect((await send(id)).status).toBe(200);
    expect(sends).toHaveLength(1);
  });
});
