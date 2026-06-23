import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRow {
  id: number;
  play_name: string;
  payload_json: string;
  status: string;
  send_started_at: string | null;
  last_draft_json: string | null;
  notes: string | null;
}

const state: {
  row: FakeRow;
  enrichment: Record<string, unknown>;
  articles: unknown[];
  extract: Record<string, unknown>;
  enqueueResult: number | null;
  existingRow: FakeRow | null;
  calls: { deepResearchPerson: number; llm: number; setStatus: number };
} = {
  row: {
    id: 7,
    play_name: "profile-intro",
    payload_json: "{}",
    status: "pending",
    send_started_at: null,
    last_draft_json: null,
    notes: "researching profile…",
  },
  enrichment: {},
  articles: [],
  extract: {},
  enqueueResult: 7,
  existingRow: null,
  calls: { deepResearchPerson: 0, llm: 0, setStatus: 0 },
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      llmProvider: "anthropic",
      llmModel: "test",
      telemetryEnabled: false,
      founderName: "Founder",
      founderEmail: "f@x.dev",
      productOneLiner: "TestProduct SDK",
      icpOneLiner: "Engineers shipping AI agents",
      clientId: "test",
    }),
    deepResearchPerson: async () => {
      state.calls.deepResearchPerson++;
      return {
        result: { result: { enrichment: state.enrichment, articles: state.articles } },
        receiptId: 9,
      };
    },
    getLedger: () => ({
      getQueueRow: () => state.row,
      getQueueRowByDedupe: () => state.existingRow,
      updateQueuePayload: ({ id: _id, payload }: { id: number; payload: unknown }) => {
        state.row.payload_json = JSON.stringify(payload);
        if (state.existingRow) state.existingRow.payload_json = JSON.stringify(payload);
      },
      setQueueDraft: ({ id: _id, draft }: { id: number; draft: unknown }) => {
        state.row.last_draft_json = JSON.stringify(draft);
      },
      setQueueNotes: ({ id: _id, notes }: { id: number; notes: string }) => {
        state.row.notes = notes;
        if (state.existingRow) state.existingRow.notes = notes;
      },
      setQueueStatus: () => {
        state.calls.setStatus++;
      },
      enqueueTarget: () => state.enqueueResult,
      // runEmailPlay / sendDraftedEmail (dryRun path doesn't actually use these,
      // but the play module reaches getLedger()).
      upsertProspect: () => 1,
      recordSequenceEvent: () => 1,
      findProspectByEmail: () => null,
      getCachedEnrichment: () => null,
      setCachedEnrichment: () => {},
    }),
    receiptUrlForId: (id: number) => `oneshot://receipt/${id}`,
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    loadPrompt: () => "system",
    complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
      state.calls.llm++;
      const user = input.messages.find((m) => m.role === "user")?.content ?? "";
      // The draft call's input block leads with FOUNDER:; the extract call is
      // ICP/PRODUCT/DOSSIER only.
      const content = user.includes("FOUNDER:")
        ? JSON.stringify({ subject: "first ninety", body: "Hey Jane, real intro. Founder" })
        : JSON.stringify(state.extract);
      return { content, provider: "test", model: "test" };
    },
  };
});

const { runProspectResearch, parseProfileUrl, createProspectResearchJob } =
  await import("../src/add-prospect.ts");
const { playFollowupCount } = await import("../src/_cadence.ts");

function resetRow(payload: unknown): void {
  state.row = {
    id: 7,
    play_name: "profile-intro",
    payload_json: JSON.stringify(payload),
    status: "pending",
    send_started_at: null,
    last_draft_json: null,
    notes: "researching profile…",
  };
}

beforeEach(() => {
  state.calls = { deepResearchPerson: 0, llm: 0, setStatus: 0 };
  state.enrichment = {};
  state.articles = [];
  state.extract = {};
  state.enqueueResult = 7;
  state.existingRow = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("profile-intro play registration", () => {
  it("registers a 3-step follow-up sequence (intro + 2 follow-ups + breakup)", () => {
    expect(playFollowupCount("profile-intro")).toBe(3);
  });
});

describe("parseProfileUrl", () => {
  it("classifies LinkedIn, X, Twitter, and GitHub", () => {
    expect(parseProfileUrl("https://www.linkedin.com/in/jane/").platform).toBe("linkedin");
    expect(parseProfileUrl("https://x.com/jane").platform).toBe("twitter");
    expect(parseProfileUrl("https://twitter.com/jane").platform).toBe("twitter");
    expect(parseProfileUrl("https://github.com/jane").platform).toBe("github");
  });

  it("normalizes to a host/path dedupe key (drops www, query, trailing slash)", () => {
    expect(parseProfileUrl("https://www.linkedin.com/in/jane/?x=1").dedupeKey).toBe(
      "linkedin.com/in/jane",
    );
  });

  it("rejects junk and unsupported hosts", () => {
    expect(() => parseProfileUrl("not a url")).toThrow();
    expect(() => parseProfileUrl("https://example.com/jane")).toThrow(/unsupported/);
  });
});

describe("createProspectResearchJob", () => {
  it("enqueues a new row and returns its id", () => {
    state.enqueueResult = 42;
    const res = createProspectResearchJob({ url: "https://x.com/jane" });
    expect(res).toEqual({ queueId: 42 });
  });

  it("returns duplicate when an already-drafted row exists", () => {
    state.enqueueResult = null; // unique-index collision
    state.existingRow = {
      id: 9,
      play_name: "profile-intro",
      payload_json: "{}",
      status: "pending",
      send_started_at: null,
      last_draft_json: JSON.stringify({ subject: "s", body: "b" }), // has a draft
      notes: null,
    };
    const res = createProspectResearchJob({ url: "https://x.com/jane" });
    expect(res).toEqual({ duplicate: true });
  });

  it("reuses a stuck placeholder (no draft) so a re-add retries instead of blocking", () => {
    state.enqueueResult = null;
    state.existingRow = {
      id: 9,
      play_name: "profile-intro",
      payload_json: "{}",
      status: "pending",
      send_started_at: null,
      last_draft_json: null, // research never produced a draft
      notes: "research failed: boom",
    };
    const res = createProspectResearchJob({ url: "https://x.com/jane" });
    expect(res).toEqual({ queueId: 9 });
    expect(state.calls.setStatus).toBe(1); // re-activated
    expect(state.existingRow.notes).toBe("researching profile…");
  });
});

describe("runProspectResearch", () => {
  it("bails with a note when research turns up nothing (no fabricated draft)", async () => {
    resetRow({ url: "https://x.com/ghost", platform: "twitter" });
    state.enrichment = {}; // empty
    state.articles = [];

    await runProspectResearch(7);

    expect(state.calls.deepResearchPerson).toBe(1);
    expect(state.calls.llm).toBe(0); // no extract, no draft
    expect(state.row.last_draft_json).toBeNull();
    expect(state.row.notes).toContain("couldn't research this profile");
  });

  it("researches, drafts, and persists the dossier + draft; clears the note when an email is found", async () => {
    resetRow({ url: "https://x.com/jane", platform: "twitter" });
    state.enrichment = { displayname: "Jane Doe", best_work_email: "jane@acme.com" };
    state.extract = { name: "Jane Doe", company: "Acme", angle: "ships an agent SDK", email: null };

    await runProspectResearch(7);

    expect(state.calls.deepResearchPerson).toBe(1);
    // Two LLM calls: the ICP-grounded extract + the intro draft.
    expect(state.calls.llm).toBe(2);

    // Draft persisted.
    expect(state.row.last_draft_json).not.toBeNull();
    const draft = JSON.parse(state.row.last_draft_json!);
    expect(draft.subject).toBe("first ninety");
    expect(draft.dryRun).toBe(true);
    expect(draft.sent).toBe(false);

    // Payload rewritten to the full target incl. dossier + resolved email.
    const payload = JSON.parse(state.row.payload_json);
    expect(payload.email).toBe("jane@acme.com");
    expect(payload.twitterUrl).toBe("https://x.com/jane");
    expect(typeof payload.dossier).toBe("string");
    expect(payload.dossier).toContain("jane@acme.com");

    // Email found → note cleared.
    expect(state.row.notes).toBe("");
  });

  it("flags 'no email found' when research + extract yield no email", async () => {
    resetRow({ url: "https://www.linkedin.com/in/jane", platform: "linkedin" });
    state.enrichment = { displayname: "Jane Doe" }; // no emails
    state.extract = { name: "Jane Doe", company: "Acme", angle: "x", email: null };

    await runProspectResearch(7);

    const payload = JSON.parse(state.row.payload_json);
    expect(payload.email).toBeNull();
    expect(payload.linkedinUrl).toBe("https://www.linkedin.com/in/jane");
    // Draft still produced, but the row is flagged so it can't be sent yet.
    expect(state.row.last_draft_json).not.toBeNull();
    expect(state.row.notes).toBe("no email found — add an email before sending");
  });

  it("prefers an explicit email override over researched emails", async () => {
    resetRow({
      url: "https://x.com/jane",
      platform: "twitter",
      emailOverride: "override@acme.com",
    });
    state.enrichment = { best_work_email: "found@acme.com" };
    state.extract = { name: "Jane", company: "Acme", angle: "x", email: "extracted@acme.com" };

    await runProspectResearch(7);

    const payload = JSON.parse(state.row.payload_json);
    expect(payload.email).toBe("override@acme.com");
  });
});
