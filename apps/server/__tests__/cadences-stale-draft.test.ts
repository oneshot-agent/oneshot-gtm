import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "@oneshot-gtm/core";

// /api/cadences says when a stored follow-up preview was written under
// another setup than today's (or before previews carried a config key): the
// row reads stale until it is previewed again.

const base = {
  play_name: "accelerator-batch",
  current_step: 0,
  enrolled_at: "2026-09-25T20:46:44Z",
  next_due_at: "2026-09-30T20:46:44Z",
  last_polled_at: null,
  next_step_drafted_at: null,
  sending_started_at: null,
  prospect_name: "X",
  prospect_company: "Example Co",
  status: "active",
};
let rows: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    recentTouchElsewhere: () => null,
    getLedger: () => ({
      findDirectMail: () => null,
      getMailAddress: () => null,
      listAllCadences: () => rows,
      listSequenceEventsForCadences: () => new Map(),
      latestSentQueuePayloads: () => new Map(),
    }),
  };
});

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    nextStepInfo: () => ({ label: "follow-up", isBreakup: false, channel: "email" }),
    playFollowupCount: () => 1,
    getPriorStepsBulk: () => new Map(),
  };
});

const { listCadences } = await import("../src/api/cadences.ts");
const { draftConfigKey } = await import("@oneshot-gtm/plays");

const key = () =>
  draftConfigKey(loadConfig(), {
    surface: { channel: "email", stage: "follow_up" },
    playName: "accelerator-batch",
  });

function preview(configKey?: string, kind = "email"): string {
  return JSON.stringify({
    subject: "s",
    body: "b",
    flags: [],
    payload: { kind },
    draftedAt: "2026-10-01T00:00:00Z",
    ...(configKey ? { configKey } : {}),
  });
}

const drafts = async () => {
  const res = listCadences(
    new Request("http://localhost/api/cadences", { headers: { host: "127.0.0.1:3030" } }),
  );
  const body = (await res.json()) as {
    cadences: Array<{ prospectId: number; nextStepDraft: { stale?: boolean } | null }>;
  };
  return new Map(body.cadences.map((c) => [c.prospectId, c.nextStepDraft]));
};

beforeEach(() => {
  saveConfig({ ...loadConfig(), founderAdmission: "a fictional concession" });
});

describe("listCadences stale previews", () => {
  it("marks a preview with no key or another key stale, never one with today's", async () => {
    rows = [
      {
        ...base,
        prospect_id: 1,
        prospect_email: "a@example.test",
        next_step_draft_json: preview(key()),
      },
      {
        ...base,
        prospect_id: 2,
        prospect_email: "b@example.test",
        next_step_draft_json: preview(),
      },
      {
        ...base,
        prospect_id: 3,
        prospect_email: "c@example.test",
        next_step_draft_json: preview("0ld0ld0ld0ld"),
      },
      {
        ...base,
        prospect_id: 4,
        prospect_email: "d@example.test",
        next_step_draft_json: preview(undefined, "direct_mail"),
      },
    ];
    const out = await drafts();
    expect(out.get(1)?.stale).toBeUndefined();
    expect(out.get(2)?.stale).toBe(true);
    expect(out.get(3)?.stale).toBe(true);
    // A letter is reviewed on its own: never stale here.
    expect(out.get(4)?.stale).toBeUndefined();
  });

  it("a preview turns stale once the setup it was written under changes", async () => {
    rows = [
      {
        ...base,
        prospect_id: 1,
        prospect_email: "a@example.test",
        next_step_draft_json: preview(key()),
      },
    ];
    expect((await drafts()).get(1)?.stale).toBeUndefined();
    saveConfig({ ...loadConfig(), founderAdmission: null });
    expect((await drafts()).get(1)?.stale).toBe(true);
  });
});
