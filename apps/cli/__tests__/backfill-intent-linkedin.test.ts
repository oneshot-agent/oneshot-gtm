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

const { Ledger, LinkedInInboxStore, canonicalLinkedInProfileKey, configDir, currentWorkspaceName } =
  await import("@oneshot-gtm/core");
const { commandIntelBackfillIntent } = await import("../src/commands/intel.ts");

let store: InstanceType<typeof LinkedInInboxStore>;
const result = (intent: string) => ({
  intent,
  reason: intent,
  confidence: 0.9,
  probabilities: null,
  classifier: "decisions:stub",
  costMicros: 1,
  review: false,
  fellBack: false,
});
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
  classifyMock.mockResolvedValue(result("interested"));
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

it("says how many replies failed every retry, and --retry-failed labels them", async () => {
  for (let i = 0; i < 30; i++)
    for (let n = 0; n < 3; n++) store.recordMessageIntentFailure("mine", `m${i}`);
  await commandIntelBackfillIntent({ linkedin: true, linkedinStore: store });
  expect(classifyMock).not.toHaveBeenCalled();
  expect(vi.mocked(process.stdout.write).mock.calls.flat().join("")).toContain(
    "30 LinkedIn replies failed every retry",
  );
  // A dry run classifies them and still writes nothing.
  await commandIntelBackfillIntent({
    linkedin: true,
    retryFailed: true,
    dryRun: true,
    limit: 2,
    linkedinStore: store,
  });
  expect(classifyMock).toHaveBeenCalledTimes(2);
  expect(labelled()).toBe(0);
  expect(store.exhaustedReplyCount(["mine"])).toBe(30);
  await commandIntelBackfillIntent({ linkedin: true, retryFailed: true, linkedinStore: store });
  expect(labelled()).toBe(30);
});

it("an unsubscribe stops the person's live cadences; a dry run stops nothing", async () => {
  const ledger = new Ledger(join(configDir(), "ledger.sqlite"));
  try {
    const slug = `ada-${randomUUID().slice(0, 8)}`;
    const url = `https://linkedin.com/in/${slug}`;
    const prospectId = ledger.upsertProspect({
      email: `${slug}@example.test`,
      name: "Ada",
      linkedin_url: url,
    });
    store.db.exec("DELETE FROM messages");
    store.saveConversation(
      "mine",
      { id: slug, attendees: [{ is_self: false, profile_url: url }] } as never,
      [],
    );
    store.assign(`linkedin:mine:${slug}`, { workspace: currentWorkspaceName(), prospectId });
    store.saveMessages("mine", [
      {
        id: "stop",
        conversation_id: slug,
        direction: "inbound",
        sender_name: "Ada",
        text: "Please stop messaging me",
        sent_at: "2026-11-01T10:00:00Z",
        deleted: false,
        attachments: [],
      },
    ] as never);
    store.deliverAll(store.threads(), [
      {
        workspace: currentWorkspaceName(),
        home: configDir(),
        prospectId,
        name: "Ada",
        profile: canonicalLinkedInProfileKey(url)!,
      },
    ]);
    ledger.enrollCadence({ prospectId, playName: "intro", nextDueAt: "2026-12-01T09:00:00.000Z" });
    classifyMock.mockResolvedValue(result("unsubscribe"));

    await commandIntelBackfillIntent({ linkedin: true, dryRun: true, linkedinStore: store });
    expect(store.messageIntent("mine", "stop")).toBeNull();
    expect(ledger.getCadence(prospectId, "intro")?.status).toBe("active");

    await commandIntelBackfillIntent({ linkedin: true, linkedinStore: store });
    expect(store.messageIntent("mine", "stop")?.intent).toBe("unsubscribe");
    expect(ledger.getCadence(prospectId, "intro")?.status).toBe("unsubscribed");
  } finally {
    ledger.close();
  }
});
