import { beforeEach, afterEach, expect, it, vi } from "vitest";
const complete = vi.fn();
const reserve = vi.fn();
const release = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete: (...args: unknown[]) => complete(...args),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  tryReserveDailySpend: (...args: unknown[]) => reserve(...args),
}));
const { getReplyReviewStore, getLinkedInInboxStore } = await import("@oneshot-gtm/core");
const { refreshReplyLearning, REPLY_LEARNING_PROMPT } = await import("../src/reply-learning.ts");
const store = getReplyReviewStore();
const now = 2_000_000_000_000;
function seed(id = "send-1", workspace = "default") {
  store.db.query("INSERT INTO reply_learning_observations(id,workspace,data) VALUES(?,?,?)").run(
    id,
    workspace,
    JSON.stringify({
      id,
      workspace,
      threadKey: id,
      name: "Ada",
      original: "long",
      body: "short",
      historical: false,
      feedback: ["In general, keep replies concise"],
      learningVersion: 0,
      move: "answer",
      at: new Date(now).toISOString(),
    }),
  );
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (const table of [
    "reply_learning_state",
    "reply_learning_preferences",
    "reply_learning_observations",
    "reply_learning_artifacts",
    "review_sends",
    "review_threads",
  ])
    store.db.exec(`DELETE FROM ${table}`);
  const inbox = getLinkedInInboxStore();
  inbox.db.exec("DELETE FROM accounts; DELETE FROM conversations; DELETE FROM assignments");
  complete.mockReset().mockResolvedValue({
    content: JSON.stringify({
      preferences: [
        {
          key: "concise",
          instruction: "Keep replies concise.",
          source: "explicit",
          evidenceIds: ["send-1"],
        },
      ],
    }),
  });
  release.mockReset();
  reserve.mockReset().mockReturnValue({ granted: true, release });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("synthesizes only the current workspace with disabled guidance and bounded evidence", async () => {
  seed();
  seed("other", "other");
  store.db
    .query("INSERT INTO reply_learning_preferences VALUES(?,?,?,?,?,?)")
    .run("default", "no-emoji", "Avoid emoji.", "explicit", 0, "[]");
  await refreshReplyLearning();
  expect(store.learning.guidance("default").instructions).toEqual(["Keep replies concise."]);
  const data = JSON.parse(complete.mock.calls[0]![0].messages[1].content);
  expect(data.observations).toHaveLength(1);
  expect(data.existingPreferences[0]).toMatchObject({ key: "no-emoji", enabled: false });
  expect(REPLY_LEARNING_PROMPT).toContain("NEVER propose equivalent or paraphrased");
  expect(REPLY_LEARNING_PROMPT).toContain("stays local");
  expect(release).toHaveBeenCalledTimes(1);
  expect(store.learning.status("other").preferences).toEqual([]);
});
it("keeps evidence pending on malformed output and retries after the persistent cooldown", async () => {
  seed();
  complete.mockResolvedValueOnce({ content: "bad output with private text" });
  await refreshReplyLearning();
  expect(store.learning.status("default")).toMatchObject({
    pending: true,
    error: "Could not refresh reply preferences; will retry.",
  });
  await refreshReplyLearning();
  expect(complete).toHaveBeenCalledTimes(1);
  vi.mocked(Date.now).mockReturnValue(now + 300_000);
  await refreshReplyLearning();
  expect(store.learning.status("default")).toMatchObject({ pending: false, error: null });
});
it("does not spend while paused or capped and preserves existing guidance on failure", async () => {
  seed();
  store.learning.setEnabled("default", false);
  await refreshReplyLearning();
  expect(reserve).not.toHaveBeenCalled();
  store.learning.setEnabled("default", true);
  reserve.mockReturnValue({ granted: false, reason: "cap" });
  await refreshReplyLearning();
  expect(complete).not.toHaveBeenCalled();
  expect(store.learning.status("default").pending).toBe(true);
  vi.mocked(Date.now).mockReturnValue(now + 300_000);
  reserve.mockReturnValue({ granted: true, release });
  await refreshReplyLearning();
  seed("new");
  vi.mocked(Date.now).mockReturnValue(now + 600_000);
  complete.mockRejectedValue(new Error("provider failed private text"));
  await refreshReplyLearning();
  expect(store.learning.guidance("default").instructions).toEqual(["Keep replies concise."]);
});
it("does not consume evidence arriving during synthesis", async () => {
  seed();
  complete.mockImplementation(async () => {
    seed("new");
    return { content: '{"preferences":[]}' };
  });
  await refreshReplyLearning();
  expect(store.learning.status("default").pending).toBe(true);
});

it("renews the persisted lease through slow provider retries and prevents a second reservation", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  seed();
  let resolve!: (value: { content: string }) => void;
  complete.mockImplementation(
    () =>
      new Promise<{ content: string }>((r) => {
        resolve = r;
      }),
  );
  const running = refreshReplyLearning();
  try {
    for (let elapsed = 60_000; elapsed <= 360_000; elapsed += 60_000) {
      vi.mocked(Date.now).mockReturnValue(now + elapsed);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await refreshReplyLearning();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    resolve({ content: '{"preferences":[]}' });
    await running;
    expect(store.learning.status("default").pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    resolve({ content: '{"preferences":[]}' });
    await running;
  }
});
