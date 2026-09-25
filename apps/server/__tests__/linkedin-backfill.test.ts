import { beforeEach, expect, it, vi } from "vitest";
const sdk = vi.fn();
const capture = vi.fn();
vi.mock("../src/linkedin-client.ts", () => ({
  callLinkedIn: (...args: unknown[]) => sdk(...args),
}));
vi.mock("../src/linkedin-sync.ts", () => ({
  refreshLinkedInInbox: (...args: unknown[]) => capture(...args),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  linkedInMatches: () => [],
}));
const { getLinkedInInboxStore, getReplyReviewStore } = await import("@oneshot-gtm/core");
const { startLinkedInBackfill, runLinkedInBackfill, backfillStatus } =
  await import("../src/linkedin-backfill.ts");
const store = getLinkedInInboxStore();
const status = (over = {}) => ({
  sync_state: "partial",
  coverage: { complete: false, provider_history: "requested", pending_cursor: false },
  active_run: null,
  ...over,
});
beforeEach(() => {
  store.db.exec(
    "DELETE FROM accounts; DELETE FROM conversations; DELETE FROM messages; DELETE FROM progress; DELETE FROM identities;",
  );
  getReplyReviewStore().db.exec("DELETE FROM review_leases");
  store.saveAccount({
    key: "account",
    wallet: "wallet",
    workspace: "test",
    account: {
      id: "id",
      status: "connected",
      allowed_actions: ["read", "reply", "view_profile"],
    } as never,
    sync: null,
    checkedAt: null,
    error: null,
  });
  sdk.mockReset();
  capture.mockReset();
  capture.mockImplementation(async () => {
    for (const r of ["active", "archived", "messages"])
      store.saveProgress(`account:${r}`, { complete: true });
  });
  sdk.mockImplementation(async (_w, op) => {
    if (op.kind === "status") return status();
    if (op.kind === "profile")
      return { profile: { provider_id: op.identifier, public_identifier: "ada", name: "Ada" } };
    throw new Error(`Unexpected ${op.kind}`);
  });
});
function sender() {
  store.saveMessages("account", [
    {
      id: "one",
      conversation_id: "chat",
      sender_provider_id: "internal",
      sender_name: "Ada",
      direction: "inbound",
      text: "Hi",
      sent_at: "2020-01-01",
    },
  ] as never);
}
it("captures every local page before spending on identity resolution", async () => {
  sender();
  startLinkedInBackfill("account");
  capture.mockImplementationOnce(async () => {
    store.saveProgress("account:messages", { cursor: "next", complete: false });
  });
  await runLinkedInBackfill("account");
  expect(backfillStatus("account")?.stage).toBe("capture");
  expect(sdk).not.toHaveBeenCalled();
  await runLinkedInBackfill("account");
  expect(store.identity("account", "internal")?.profile).toBe("linkedin.com/in/ada");
  expect(backfillStatus("account")?.stage).toBe("waiting");
});
it("waits on ongoing provider history instead of buying repeated imports", async () => {
  startLinkedInBackfill("account");
  await runLinkedInBackfill("account");
  await runLinkedInBackfill("account");
  expect(sdk.mock.calls.every(([, op]) => op.kind === "status")).toBe(true);
  expect(backfillStatus("account")?.stage).toBe("waiting");
});
it("pauses for permission and resumes with cached identities reused", async () => {
  sender();
  const a = store.account("account")!;
  a.account.allowed_actions = ["read", "reply"];
  store.saveAccount(a);
  startLinkedInBackfill("account");
  await runLinkedInBackfill("account");
  expect(backfillStatus("account")).toMatchObject({
    stage: "blocked",
    failures: [{ code: "view_profile_required" }],
  });
  expect(sdk).not.toHaveBeenCalled();
  a.account.allowed_actions.push("view_profile");
  store.saveAccount(a);
  startLinkedInBackfill("account");
  await runLinkedInBackfill("account");
  await runLinkedInBackfill("account");
  expect(sdk.mock.calls.filter(([, op]) => op.kind === "profile")).toHaveLength(1);
});
it("resumes accepted profile jobs by request ID after timeouts", async () => {
  sender();
  startLinkedInBackfill("account");
  sdk.mockResolvedValueOnce({ status: "pending", request_id: "accepted" });
  await runLinkedInBackfill("account");
  sdk.mockRejectedValueOnce(
    Object.assign(new Error("still processing"), { name: "JobTimeoutError", jobId: "accepted" }),
  );
  await runLinkedInBackfill("account");
  expect(backfillStatus("account")?.stage).toBe("resolve");
  sdk.mockResolvedValueOnce({ profile: { provider_id: "internal", public_identifier: "ada" } });
  await runLinkedInBackfill("account");
  expect(sdk.mock.calls.filter(([, op]) => op.kind === "profile")).toHaveLength(1);
  expect(
    sdk.mock.calls.filter(([, op]) => op.kind === "wait").map(([, op]) => op.requestId),
  ).toEqual(["accepted", "accepted"]);
});
it("keeps one idempotency key across payment failures with unknown acceptance", async () => {
  sender();
  startLinkedInBackfill("account");
  sdk.mockRejectedValueOnce(Object.assign(new Error("insufficient funds"), { statusCode: 402 }));
  await runLinkedInBackfill("account");
  const pending = backfillStatus("account")!.pending!;
  expect(backfillStatus("account")?.stage).toBe("blocked");
  startLinkedInBackfill("account");
  await runLinkedInBackfill("account");
  const submissions = sdk.mock.calls.filter(([, op]) => op.kind === "profile");
  expect(submissions.map(([, op]) => op.idempotencyKey)).toEqual([
    pending.idempotencyKey,
    pending.idempotencyKey,
  ]);
});
it("replaces a key the provider consumed without a request id, once", async () => {
  sender();
  startLinkedInBackfill("account");
  const burned = () =>
    sdk.mockRejectedValueOnce(
      new Error("Tool request failed: This Idempotency-Key was already used for a LinkedIn action"),
    );
  burned();
  await runLinkedInBackfill("account");
  const first = backfillStatus("account")!;
  // Not blocked: the next tick retries under a fresh key.
  expect(first.stage).toBe("resolve");
  expect(first.pending?.rekeyed).toBe(true);
  await runLinkedInBackfill("account");
  const keys = sdk.mock.calls
    .filter(([, op]) => op.kind === "profile")
    .map(([, op]) => op.idempotencyKey);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
  expect(backfillStatus("account")?.senders?.resolved).toBe(1);
  // A second refusal on the fresh key is a real fault and blocks as before.
  sender();
  burned();
  await runLinkedInBackfill("account");
  burned();
  await runLinkedInBackfill("account");
  expect(backfillStatus("account")?.stage).toBe("blocked");
});
it("a shared lease prevents another server from submitting the same work", async () => {
  sender();
  startLinkedInBackfill("account");
  const token = getReplyReviewStore().claim("backfill:account")!;
  await runLinkedInBackfill("account");
  expect(sdk).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  getReplyReviewStore().release("backfill:account", token);
  await runLinkedInBackfill("account");
  expect(sdk.mock.calls.filter(([, op]) => op.kind === "profile")).toHaveLength(1);
});
it("continues only a warranted provider cursor and resumes accepted sync work", async () => {
  startLinkedInBackfill("account");
  sdk.mockResolvedValueOnce(
    status({
      coverage: { complete: false, provider_history: "done", pending_cursor: true },
      last_run: { run_id: "previous" },
    }),
  );
  sdk.mockResolvedValueOnce({ status: "pending", request_id: "import" });
  await runLinkedInBackfill("account");
  expect(backfillStatus("account")?.pending?.requestId).toBe("import");
  sdk.mockResolvedValueOnce({ outcome: "exhausted" });
  await runLinkedInBackfill("account");
  expect(sdk.mock.calls.filter(([, op]) => op.kind === "sync")).toHaveLength(1);
  expect(sdk.mock.calls.at(-1)?.[1]).toEqual({ kind: "wait", requestId: "import" });
  expect(backfillStatus("account")?.stage).toBe("capture");
});
it("captures provider completion before marking the job complete", async () => {
  startLinkedInBackfill("account");
  await runLinkedInBackfill("account");
  sdk.mockImplementation(async () =>
    status({ sync_state: "complete", coverage: { complete: true, provider_history: "done" } }),
  );
  await runLinkedInBackfill("account");
  expect(backfillStatus("account")?.stage).toBe("capture");
  await runLinkedInBackfill("account");
  expect(backfillStatus("account")?.stage).toBe("complete");
  expect(capture).toHaveBeenCalledTimes(2);
});

it("waits for the provider's reported daily reset without imposing a separate cap or buying more work", async () => {
  sender();
  store.saveMessages("account", [
    {
      id: "two",
      conversation_id: "chat",
      sender_provider_id: "second",
      sender_name: "Bob",
      direction: "inbound",
      text: "Hi",
      sent_at: "2020-01-02",
    },
  ] as never);
  startLinkedInBackfill("account");
  const reset = new Date(Date.now() + 3600000).toISOString();
  sdk.mockResolvedValueOnce({
    profile: { provider_id: "internal", public_identifier: "ada" },
    linkedin: { headroom: { limit: 1, used: 0, pending: 1, resets_at: reset } },
  });
  await runLinkedInBackfill("account");
  expect(backfillStatus("account")).toMatchObject({
    stage: "resolve",
    nextAttemptAt: reset,
    senders: { total: 2, resolved: 1 },
  });
  expect(sdk).toHaveBeenCalledTimes(1);
  await runLinkedInBackfill("account");
  expect(sdk).toHaveBeenCalledTimes(1);
  const job = backfillStatus("account")!;
  job.nextAttemptAt = "2000-01-01T00:00:00Z";
  job.providerLimit!.resetsAt = job.nextAttemptAt;
  store.saveProgress("backfill:account", job);
  await runLinkedInBackfill("account");
  expect(sdk.mock.calls.filter(([, op]) => op.kind === "profile")).toHaveLength(2);
  expect(store.identity("account", "second")?.profile).toBe("linkedin.com/in/ada");
});

it("finishes an accepted request even when its reservation consumes the last daily slot", async () => {
  sender();
  startLinkedInBackfill("account");
  sdk.mockResolvedValueOnce({
    status: "pending",
    request_id: "last-slot",
    linkedin: {
      headroom: {
        limit: 1,
        used: 0,
        pending: 1,
        resets_at: new Date(Date.now() + 3600000).toISOString(),
      },
    },
  });
  await runLinkedInBackfill("account");
  sdk.mockResolvedValueOnce({ profile: { provider_id: "internal", public_identifier: "ada" } });
  await runLinkedInBackfill("account");
  expect(sdk.mock.calls[1]?.[1]).toEqual({ kind: "wait", requestId: "last-slot" });
  expect(store.identity("account", "internal")?.profile).toBe("linkedin.com/in/ada");
  expect(backfillStatus("account")?.nextAttemptAt).toBeUndefined();
});

it("imports a replacement's initial provider history before resolving identities", async () => {
  sender();
  startLinkedInBackfill("account");
  capture.mockImplementationOnce(async () => {
    for (const r of ["active", "archived", "messages"])
      store.saveProgress(`account:${r}`, { complete: true });
    store.saveAccount({
      ...store.account("account")!,
      sync: status({
        sync_state: "never_synced",
        coverage: { complete: false, provider_history: "never", pending_cursor: false },
      }) as never,
    });
  });
  sdk.mockResolvedValueOnce(
    status({
      sync_state: "never_synced",
      coverage: { complete: false, provider_history: "never", pending_cursor: false },
    }),
  );
  sdk.mockResolvedValueOnce({ status: "pending", request_id: "initial-history" });
  await runLinkedInBackfill("account");
  expect(sdk.mock.calls.map(([, op]) => op.kind)).toEqual(["status", "sync"]);
  expect(backfillStatus("account")).toMatchObject({
    stage: "provider",
    pending: { kind: "sync", requestId: "initial-history" },
  });
});

it.each(["content_rejected", "target_not_found"])(
  "preserves terminal %s evidence and continues without repurchasing",
  async (code) => {
    sender();
    startLinkedInBackfill("account");
    sdk.mockResolvedValueOnce({ status: "pending", request_id: "rejected-job" });
    await runLinkedInBackfill("account");
    sdk.mockRejectedValueOnce(
      Object.assign(new Error("Lookup rejected"), { code, requestId: "rejected-job" }),
    );
    await runLinkedInBackfill("account");
    expect(store.identity("account", "internal")).toMatchObject({
      profile: null,
      requestId: "rejected-job",
      failure: { code },
    });
    expect(backfillStatus("account")).toMatchObject({
      stage: "resolve",
      senders: { resolved: 1, failed: 1 },
    });
    expect(backfillStatus("account")?.pending).toBeUndefined();
    store.saveMessages("account", [
      {
        id: "two",
        conversation_id: "chat2",
        sender_provider_id: "other",
        direction: "inbound",
        text: "Hello",
        sent_at: "2020-01-02",
      },
    ] as never);
    await runLinkedInBackfill("account");
    await runLinkedInBackfill("account");
    expect(
      sdk.mock.calls.filter(([, op]) => op.kind === "profile").map(([, op]) => op.identifier),
    ).toEqual(["internal", "other"]);
    expect(backfillStatus("account")?.stage).toBe("waiting");
  },
);

it.each(["account_disconnected", "rate_limited", "provider_unavailable"])(
  "still blocks on %s without caching a failed identity",
  async (code) => {
    sender();
    startLinkedInBackfill("account");
    sdk.mockRejectedValueOnce(
      Object.assign(new Error("Account failure"), { code, requestId: "accepted" }),
    );
    await runLinkedInBackfill("account");
    expect(backfillStatus("account")?.stage).toBe("blocked");
    expect(backfillStatus("account")?.pending?.requestId).toBe("accepted");
    expect(store.identity("account", "internal")).toBeNull();
  },
);
