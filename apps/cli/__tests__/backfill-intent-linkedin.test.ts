import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// `backfill-intent --linkedin` against a real inbox store; the classifier is
// mocked, so no model call happens.
const classifyMock = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, classifyReplyIntent: classifyMock };
});

const { LinkedInInboxStore, currentWorkspaceName } = await import("@oneshot-gtm/core");
const { commandIntelBackfillIntent } = await import("../src/commands/intel.ts");

let store: InstanceType<typeof LinkedInInboxStore>;
beforeEach(() => {
  store = new LinkedInInboxStore(join(tmpdir(), `backfill-linkedin-${randomUUID()}.sqlite`));
  store.saveAccount({
    key: "mine",
    wallet: "wallet",
    workspace: currentWorkspaceName(),
    account: { id: "mine", status: "connected", allowed_actions: [] } as never,
    sync: null,
    checkedAt: null,
    error: null,
  });
  // More than one batch of 25, so the loop has to come back for the rest.
  store.saveMessages(
    "mine",
    Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      conversation_id: "chat",
      direction: "inbound",
      sender_name: "Ada",
      text: "Tell me more",
      sent_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
      deleted: false,
      attachments: [],
    })) as never,
  );
  classifyMock.mockReset();
  classifyMock.mockResolvedValue({
    intent: "interested",
    reason: "interested",
    confidence: 0.9,
    probabilities: null,
    classifier: "decisions:stub",
    costMicros: 1,
    review: false,
    fellBack: false,
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

const labelled = () =>
  Array.from({ length: 30 }, (_, i) => store.messageIntent("mine", `m${i}`)).filter(Boolean).length;

it("labels every unlabelled LinkedIn reply, batch after batch", async () => {
  await commandIntelBackfillIntent({ linkedin: true, linkedinStore: store });
  expect(classifyMock).toHaveBeenCalledTimes(30);
  expect(labelled()).toBe(30);
  // Nothing left: a second run pays for nothing.
  await commandIntelBackfillIntent({ linkedin: true, linkedinStore: store });
  expect(classifyMock).toHaveBeenCalledTimes(30);
});

it("--limit caps the total, and a dry run writes nothing", async () => {
  await commandIntelBackfillIntent({
    linkedin: true,
    limit: 3,
    dryRun: true,
    linkedinStore: store,
  });
  expect(classifyMock).toHaveBeenCalledTimes(3);
  expect(labelled()).toBe(0);
  await commandIntelBackfillIntent({ linkedin: true, limit: 27, linkedinStore: store });
  expect(labelled()).toBe(27);
});

it("ends when every remaining reply fails", async () => {
  classifyMock.mockRejectedValue(new Error("model down"));
  await commandIntelBackfillIntent({ linkedin: true, linkedinStore: store });
  expect(classifyMock).toHaveBeenCalledTimes(30);
  expect(labelled()).toBe(0);
});
