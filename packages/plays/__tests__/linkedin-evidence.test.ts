import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = new Map<string, { result_json: string; fetched_at: string; status: string | null }>();
const completions: Array<Array<{ role: string; content: string }>> = [];
let replies: string[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getCachedEnrichment: (key: string) => cache.get(key) ?? null,
      setCachedEnrichment: (key: string, json: string) =>
        cache.set(key, { result_json: json, fetched_at: new Date().toISOString(), status: null }),
      setCachedEnrichmentFailure: (key: string, message: string) =>
        cache.set(key, {
          result_json: JSON.stringify({ error: message }),
          fetched_at: new Date().toISOString(),
          status: "failed",
        }),
    }),
  };
});
vi.mock("@oneshot-gtm/intel", () => ({
  loadPrompt: (name: string) => `prompt:${name}`,
  complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
    completions.push(input.messages);
    return { content: replies.shift() ?? "" };
  },
}));

const {
  agedEvidence,
  companyTheyRun,
  draftWithRepair,
  isFounderTitle,
  lintAlreadyConnected,
  lintLinkedInClose,
  lintLinkedInFirstMessage,
  lintLinkedInNote,
  profileViewReader,
  readerRole,
  storedFounderCompany,
  tidyCompanyName,
  tidyEventTitle,
  _resetLinkedInLiveReads,
} = await import("../src/_linkedin-evidence.ts");

const { _resetPaidCache, getSharedDb, paidCacheKey, readPaidCache } =
  await import("@oneshot-gtm/core");

/** Forget stored reads: the ledger's rows and the paid cache's. */
function clearStored(): void {
  cache.clear();
  _resetPaidCache();
}

const DAY = 86_400_000;
const NOW = new Date("2026-10-12T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const dayStr = (n: number) => daysAgo(n).toISOString();

beforeEach(() => {
  clearStored();
  completions.length = 0;
  replies = [];
  _resetLinkedInLiveReads();
});

describe("agedEvidence", () => {
  const at = (meta: Record<string, unknown>, days: number) =>
    agedEvidence(meta, { contactedAt: daysAgo(days), now: NOW });

  it("repo star never ages", () => {
    expect(at({ repo: "acme/widgets" }, 0)).toBe("starred acme/widgets");
    expect(at({ repo: "acme/widgets" }, 900)).toBe("starred acme/widgets");
  });

  it.each([
    [
      "upcoming",
      { eventTitle: "Agents Night", eventDate: dayStr(-3) },
      "signed up for Agents Night",
    ],
    [
      "today-ish past",
      { eventTitle: "Agents Night", eventDate: dayStr(1) },
      "were at Agents Night",
    ],
    ["45 days ago", { eventTitle: "Agents Night", eventDate: dayStr(45) }, "were at Agents Night"],
    ["46 days ago", { eventTitle: "Agents Night", eventDate: dayStr(46) }, undefined],
    ["long past", { eventTitle: "Agents Night", eventDate: dayStr(400) }, undefined],
  ])("event, %s", (_label, meta, want) => {
    expect(at(meta, 0)).toBe(want);
  });

  it("strips subtitle, co-host credit and leading article from the event title", () => {
    expect(tidyEventTitle("The Agents Night: Building in Public")).toBe("Agents Night");
    expect(tidyEventTitle("An Evening of Evals – Hosted by Somebody")).toBe("Evening of Evals");
    expect(tidyEventTitle("Agents Night x Other Co")).toBe("Agents Night");
    expect(at({ eventTitle: "The Agents Night: Part 2", eventDate: dayStr(-2) }, 0)).toBe(
      "signed up for Agents Night",
    );
  });

  it.each([
    [0, "running Playwright, Vitest and Bun"],
    [44, "running Playwright, Vitest and Bun"],
    [45, "running Playwright, Vitest and Bun"],
    [46, "were running Playwright, Vitest and Bun"],
    [179, "were running Playwright, Vitest and Bun"],
    [180, "were running Playwright, Vitest and Bun"],
    [181, undefined],
  ])("vendor stack, %i days after first contact", (days, want) => {
    expect(at({ vendorStack: "Playwright, Vitest, Bun" }, days)).toBe(want);
  });

  it("accelerator cohort: present until 60 days after the batch ends, then past, never dropped", () => {
    // YC S26 demo day: 2026-09-10 (a known exact date).
    const end = new Date("2026-09-10T00:00:00Z");
    const on = (daysAfterEnd: number) =>
      agedEvidence(
        { prospectCohort: "yc-s26" },
        { contactedAt: end, now: new Date(end.getTime() + daysAfterEnd * DAY) },
      );
    expect(on(-10)).toBe("in YC S26");
    expect(on(59)).toBe("in YC S26");
    expect(on(61)).toBe("went through YC S26");
    expect(on(2000)).toBe("went through YC S26");
  });

  it.each([
    [0, "Sequoia led your Seed", "Sequoia"],
    [200, undefined, "Sequoia"],
    [44, "just raised a Seed", undefined],
    [45, "just raised a Seed", undefined],
    [46, "raised a Seed", undefined],
    [180, "raised a Seed", undefined],
    [181, undefined, undefined],
  ])("funding round, %i days", (days, want, lead) => {
    const meta = { round: "Seed", ...(lead ? { leadInvestor: lead } : {}) };
    expect(at(meta, days)).toBe(want);
  });

  it.each([
    [44, "just joined Acme as Head of Growth"],
    [45, "just joined Acme as Head of Growth"],
    [46, "joined Acme as Head of Growth"],
    [90, "joined Acme as Head of Growth"],
    [91, undefined],
  ])("job change, %i days", (days, want) => {
    expect(at({ newCompany: "Acme", newRole: "Head of Growth" }, days)).toBe(want);
  });

  it("job change without a role", () => {
    expect(at({ newCompany: "Acme" }, 10)).toBe("just joined Acme");
  });

  it.each([
    [44, "hiring an Engineer"],
    [45, "hiring an Engineer"],
    [46, undefined],
  ])("hiring, %i days", (days, want) => {
    expect(at({ jobTitle: "Engineer" }, days)).toBe(want);
  });

  it("drops a clause over 80 characters instead of cutting it", () => {
    const long = "a".repeat(80);
    expect(at({ repo: long }, 0)).toBeUndefined();
    const ok = "a".repeat(80 - "starred ".length);
    expect(at({ repo: ok }, 0)).toBe(`starred ${ok}`);
  });

  it("is empty when there is no evidence", () => {
    expect(at({}, 0)).toBeUndefined();
  });
});

describe("founder-company check (stored data)", () => {
  const base = {
    title: "Co-founder & CEO",
    company: "Soren",
    email: null as string | null,
  };

  it("corroborated by the work-email domain, prefixed or suffixed", () => {
    expect(storedFounderCompany({ ...base, email: "dana@usesoren.com" })).toBe("Soren");
    expect(storedFounderCompany({ ...base, company: "Locus", email: "a@paywithlocus.com" })).toBe(
      "Locus",
    );
    expect(storedFounderCompany({ ...base, email: "dana@soren.io" })).toBe("Soren");
  });

  it("corroborated by the dossier company_domain", () => {
    expect(storedFounderCompany({ ...base, dossierDomain: "getsoren.com" })).toBe("Soren");
  });

  it("corroborated by a current mention in the title or headline", () => {
    expect(storedFounderCompany({ ...base, title: "CEO at Soren" })).toBe("Soren");
    expect(storedFounderCompany({ ...base, headline: "Founder @ Soren | agents" })).toBe("Soren");
  });

  it("falls back to the dossier title", () => {
    expect(
      storedFounderCompany({
        ...base,
        title: null,
        dossierTitle: "Founder",
        email: "a@soren.com",
      }),
    ).toBe("Soren");
  });

  it("tidies the name", () => {
    expect(tidyCompanyName("Soren (YC F25)")).toBe("Soren");
    expect(tidyCompanyName("Soren Yc F25")).toBe("Soren");
    expect(tidyCompanyName("Soren, Inc.")).toBe("Soren");
    expect(tidyCompanyName("Soren GmbH")).toBe("Soren");
    expect(tidyCompanyName("Soren LLC")).toBe("Soren");
  });

  it.each([
    ["personal mail only", { email: "dana@gmail.com" }],
    [
      "an ex- headline",
      { title: "Founder", company: "Meta", headline: "ex-Meta, building things" },
    ],
    ["a former headline", { title: "Founder", company: "Meta", headline: "Former Meta engineer" }],
    [
      "stealth",
      {
        company: "Stealth Startup",
        email: "a@stealth.com",
        headline: "Founder at Stealth Startup",
      },
    ],
    ["a university", { company: "Stanford University", headline: "Founder, Stanford University" }],
    ["a company that is not the email domain", { company: "Soren", email: "dana@othercorp.com" }],
    ["Founders Associate", { title: "Founders Associate", email: "a@usesoren.com" }],
    ["a too-short company key", { company: "AB", email: "a@abacus.com" }],
  ])("rejects %s", (_label, over) => {
    expect(storedFounderCompany({ ...base, ...over })).toBeNull();
  });

  it("title matching is whole-word", () => {
    expect(isFounderTitle("Founding Engineer")).toBe(true);
    expect(isFounderTitle("Chief Technology Officer")).toBe(true);
    expect(isFounderTitle("Founders Associate")).toBe(false);
    expect(isFounderTitle("Account Executive")).toBe(false);
  });
});

describe("live-read rule", () => {
  const prospect = {
    title: "CEO",
    company: "Soren",
    email: "dana@usesoren.com",
    linkedin_url: "https://www.linkedin.com/in/dana-lee",
    dossier_json: null,
  };
  const reader = (
    snapshot: { headline?: string; experience?: Array<{ company: string }> } | null,
  ) => vi.fn(async () => snapshot as never);

  it("stored data agrees but there is no live read: no company", async () => {
    expect(await companyTheyRun({ playName: "p", prospect, now: NOW })).toBeNull();
    expect(
      await companyTheyRun({ playName: "p2", prospect, reader: reader(null), now: NOW }),
    ).toBeNull();
  });

  it("the live headline names another company: no company", async () => {
    const read = reader({ headline: "Founder at Otherco", experience: [] });
    expect(await companyTheyRun({ playName: "p", prospect, reader: read, now: NOW })).toBeNull();
  });

  it("the live headline names it: company passed", async () => {
    const read = reader({ headline: "CEO @ Soren", experience: [] });
    expect(await companyTheyRun({ playName: "p", prospect, reader: read, now: NOW })).toBe("Soren");
  });

  it("a current position names it: company passed; a past position does not", async () => {
    const now = reader({
      experience: [{ company: "Soren", period: "Mar 2026 - Present" } as never],
    });
    expect(await companyTheyRun({ playName: "a", prospect, reader: now, now: NOW })).toBe("Soren");
    clearStored();
    const past = reader({ experience: [{ company: "Soren", period: "2020 - 2022" } as never] });
    expect(await companyTheyRun({ playName: "b", prospect, reader: past, now: NOW })).toBeNull();
  });

  it("no live read is made for someone who fails the stored checks", async () => {
    const read = reader({ headline: "CEO @ Soren", experience: [] });
    await companyTheyRun({
      playName: "p",
      prospect: { ...prospect, title: "Founders Associate" },
      reader: read,
      now: NOW,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("one read is reused across the note and both messages", async () => {
    const read = reader({ headline: "CEO @ Soren", experience: [] });
    for (let i = 0; i < 3; i++) {
      expect(await companyTheyRun({ playName: "p", prospect, reader: read, now: NOW })).toBe(
        "Soren",
      );
    }
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a call with no reader (a batch preview) does not stop a later call from reading", async () => {
    expect(await companyTheyRun({ playName: "p", prospect, now: NOW })).toBeNull();
    const read = reader({ headline: "CEO @ Soren", experience: [] });
    expect(await companyTheyRun({ playName: "p", prospect, reader: read, now: NOW })).toBe("Soren");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a remembered read expires after a day, so a long-lived server reads again", async () => {
    const read = reader({ headline: "CEO @ Soren", experience: [] });
    await companyTheyRun({ playName: "p", prospect, reader: read, now: NOW });
    clearStored();
    await companyTheyRun({
      playName: "p",
      prospect,
      reader: read,
      now: new Date(NOW.getTime() + 2 * DAY),
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a failed read is not remembered: the next call reads again", async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({ headline: "CEO @ Soren", experience: [] });
    expect(await companyTheyRun({ playName: "p", prospect, reader: flaky, now: NOW })).toBeNull();
    expect(await companyTheyRun({ playName: "p", prospect, reader: flaky, now: NOW })).toBe(
      "Soren",
    );
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("a stored headline corroborates a founder on a personal mailbox, and the live read still decides", async () => {
    const personal = {
      ...prospect,
      title: "Founder",
      email: "dana@gmail.com",
      dossier_json: JSON.stringify({ headline: "Founder at Soren" }),
    };
    const agrees = reader({ headline: "Founder at Soren", experience: [] });
    expect(
      await companyTheyRun({ playName: "a", prospect: personal, reader: agrees, now: NOW }),
    ).toBe("Soren");
    clearStored();
    const moved = reader({ headline: "Engineer at Otherco", experience: [] });
    expect(
      await companyTheyRun({ playName: "b", prospect: personal, reader: moved, now: NOW }),
    ).toBeNull();
    clearStored();
    // The live headline says something else, but the live current position names it.
    const position = reader({
      headline: "Building agents",
      experience: [{ company: "Soren", period: "2025 - Present" } as never],
    });
    expect(
      await companyTheyRun({ playName: "d", prospect: personal, reader: position, now: NOW }),
    ).toBe("Soren");
    // Without the stored headline nothing corroborates, and no view is spent.
    const bare = reader({ headline: "Founder at Soren", experience: [] });
    expect(
      await companyTheyRun({
        playName: "c",
        prospect: { ...personal, dossier_json: null },
        reader: bare,
        now: NOW,
      }),
    ).toBeNull();
    expect(bare).not.toHaveBeenCalled();
  });

  it("a stored live read is used without calling the reader", async () => {
    // Person research's read of the profile, already in the paid cache.
    getSharedDb().setPaidCache({
      key: paidCacheKey("linkedin.profile_read", { url: "https://linkedin.com/in/dana-lee" }),
      callType: "linkedin.profile_read",
      status: "ok",
      resultJson: JSON.stringify({ headline: "Founder, Soren", experience: [] }),
      costUsd: 0.01,
      fetchedAt: NOW.toISOString(),
    });
    const read = reader(null);
    expect(await companyTheyRun({ playName: "p", prospect, reader: read, now: NOW })).toBe("Soren");
    expect(read).not.toHaveBeenCalled();
  });
});

const stillRunning = () =>
  Object.assign(new Error("still processing"), { name: "JobTimeoutError" });
const kinds = (call: ReturnType<typeof vi.fn>) =>
  call.mock.calls.map(([op]) => (op as { kind: string }).kind);

describe("profile view reader", () => {
  const URL = "https://www.linkedin.com/in/dana-lee";
  const PROFILE = { profile: { headline: "CEO @ Soren", current_company: "Soren" } };
  const make = (call: ReturnType<typeof vi.fn>, waitMs = 0) =>
    profileViewReader({
      call: call as unknown as Parameters<typeof profileViewReader>[0]["call"],
      accountId: "acct",
      idempotencyKey: "k",
      waitMs,
      pauseMs: 0,
    });

  it("an acceptance is not a read: nothing is returned and the job id is kept", async () => {
    const call = vi.fn().mockResolvedValueOnce({ status: "pending", request_id: "job-1" });
    expect(await make(call)(URL)).toBeNull();
    expect(JSON.parse(cache.get("linkedin-view-pending:k")!.result_json)).toEqual({
      requestId: "job-1",
    });
  });

  it("the next call resumes the same job instead of asking for another view", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending", request_id: "job-1" })
      .mockResolvedValueOnce({ status: "completed", result: PROFILE });
    expect(await make(call)(URL)).toBeNull();
    expect(await make(call)(URL)).toEqual({
      headline: "CEO @ Soren",
      experience: [{ company: "Soren", period: "Present" }],
    });
    expect(kinds(call)).toEqual(["profile", "wait"]);
    expect(call.mock.calls[1]![0]).toEqual({ kind: "wait", requestId: "job-1" });
    // Settled: a later call asks afresh rather than waiting on a finished job.
    expect(cache.get("linkedin-view-pending:k")?.status).toBe("failed");
  });

  it("waits on an accepted view within one call, through a still-running poll", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ status: "queued", request_id: "job-1" })
      .mockRejectedValueOnce(stillRunning())
      .mockResolvedValueOnce(PROFILE);
    expect(await make(call, 5_000)(URL)).toMatchObject({ headline: "CEO @ Soren" });
    expect(kinds(call)).toEqual(["profile", "wait", "wait"]);
  });

  it("an acceptance with no job id, a failed job, and an answer with no profile are not reads", async () => {
    expect(await make(vi.fn().mockResolvedValueOnce({ status: "pending" }), 5_000)(URL)).toBeNull();
    expect(
      await make(vi.fn().mockResolvedValueOnce({ status: "failed", error: "not found" }))(URL),
    ).toBeNull();
    expect(await make(vi.fn().mockResolvedValueOnce({ status: "completed" }))(URL)).toBeNull();
  });

  it("a view that finishes at once is a read", async () => {
    expect(await make(vi.fn().mockResolvedValueOnce(PROFILE))(URL)).toEqual({
      headline: "CEO @ Soren",
      experience: [{ company: "Soren", period: "Present" }],
    });
  });

  it("an unfinished view is never stored as the person's profile", async () => {
    const prospect = {
      title: "CEO",
      company: "Soren",
      email: "dana@usesoren.com",
      linkedin_url: URL,
      dossier_json: null,
    };
    const call = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending", request_id: "job-1" })
      .mockResolvedValueOnce({ status: "completed", result: PROFILE });
    const first = await companyTheyRun({ playName: "p", prospect, reader: make(call), now: NOW });
    expect(first).toBeNull();
    expect(readPaidCache("linkedin.profile", { url: URL })).toBeNull();
    expect(await companyTheyRun({ playName: "p", prospect, reader: make(call), now: NOW })).toBe(
      "Soren",
    );
    expect(readPaidCache("linkedin.profile", { url: URL })?.status).toBe("ok");
  });
});

describe("reader role", () => {
  it.each([
    ["Co-Founder & CEO", "founder"],
    ["Staff Software Engineer", "engineer"],
    ["PhD student", "student"],
    ["Head of Growth", "growth or operations"],
    ["Partner at Example Capital", "investor"],
    ["Poet", "unknown"],
    [null, "unknown"],
  ])("%s → %s", (title, want) => {
    expect(readerRole(title)).toBe(want);
  });
});

describe("tidy helpers on hostile input", () => {
  it("long runs of spaces do not stall them", () => {
    const t0 = Date.now();
    tidyEventTitle(` ${" ".repeat(50_000)}x${" ".repeat(50_000)}`);
    tidyEventTitle(`a${" ".repeat(50_000)}|${" ".repeat(50_000)}`);
    tidyCompanyName(`a${" ".repeat(50_000)}`);
    tidyCompanyName(`${" ".repeat(50_000)}yc w`);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("lint", () => {
  it("note: length, pitch phrases, link", () => {
    expect(lintLinkedInNote("Saw you starred acme/widgets. What are you building?")).toEqual([]);
    expect(lintLinkedInNote("x".repeat(301))[0]).toMatch(/^note-too-long/);
    expect(lintLinkedInNote("x".repeat(250))).toEqual([]);
    expect(lintLinkedInNote("x".repeat(250), 200)[0]).toMatch(/^note-too-long: 250\/200/);
    expect(lintLinkedInNote("x".repeat(301), 400)[0]).toMatch(/^note-too-long: 301\/300/);
    expect(lintLinkedInNote("I help companies like yours ship faster")).toContainEqual(
      expect.stringMatching(/^note-pitch/),
    );
    expect(lintLinkedInNote("Do you have 15 minutes?")).toContainEqual(
      expect.stringMatching(/^note-pitch/),
    );
    expect(lintLinkedInNote("Up for a quick call?")).toContainEqual(
      expect.stringMatching(/^note-pitch/),
    );
    expect(lintLinkedInNote("See https://example.com")).toContainEqual(
      expect.stringMatching(/^note-link/),
    );
  });

  it("message 1: length, exactly one question, no meeting ask, no link", () => {
    expect(
      lintLinkedInFirstMessage("Thanks for connecting. What are you building right now?"),
    ).toEqual([]);
    expect(lintLinkedInFirstMessage("y".repeat(401))[0]).toMatch(/^too-long/);
    expect(lintLinkedInFirstMessage("What are you building? Why?")).toContainEqual(
      expect.stringMatching(/^questions/),
    );
    expect(lintLinkedInFirstMessage("Thanks for connecting.")).toContainEqual(
      expect.stringMatching(/^questions/),
    );
    expect(lintLinkedInFirstMessage("Open to a quick call this week?")).toContainEqual(
      expect.stringMatching(/^meeting-ask/),
    );
    expect(lintLinkedInFirstMessage("Want to book a time? ")).toContainEqual(
      expect.stringMatching(/^meeting-ask/),
    );
    const clause = "were at Agents Demo Day";
    expect(
      lintLinkedInFirstMessage(`Saw you ${clause}. What are you building right now?`, { clause }),
    ).toEqual([]);
    expect(
      lintLinkedInFirstMessage(`Saw you ${clause}. Free for a demo? What are you building?`, {
        clause,
      }),
    ).toContainEqual(expect.stringMatching(/^meeting-ask/));
    expect(lintLinkedInFirstMessage("What are you building? https://example.com")).toContainEqual(
      expect.stringMatching(/^link/),
    );
  });

  describe("close", () => {
    const context = "PRODUCT: a tool that runs 3 checks\nEVIDENCE_CLAUSE: starred acme/widgets";
    const clause = "starred acme/widgets";
    const ok = "We make a tool that runs 3 checks on your repo. No reply needed.";

    it("passes a clean close", () => {
      expect(lintLinkedInClose(ok, { context, clause })).toEqual([]);
    });
    it("flags length, link, price, an invented number, an unsupported claim", () => {
      expect(lintLinkedInClose("z".repeat(401), { context, clause })[0]).toMatch(/^too-long/);
      expect(lintLinkedInClose(`${ok} See example.com`, { context, clause })).toContainEqual(
        expect.stringMatching(/^link/),
      );
      expect(lintLinkedInClose(`${ok} It costs $20 a month.`, { context, clause })).toContainEqual(
        expect.stringMatching(/^price/),
      );
      expect(
        lintLinkedInClose("It saves teams 40% of their time. A no is fine.", { context, clause }),
      ).toContainEqual(expect.stringMatching(/^invented-number/));
      expect(
        lintLinkedInClose("Saw you ran a big launch. A no is fine.", { context, clause }),
      ).toContainEqual(expect.stringMatching(/^unsupported-claim/));
      expect(
        lintLinkedInClose("Saw you starred acme/widgets. A no is fine.", { context, clause }),
      ).toEqual([]);
    });
    it("a second claim joined to the clause is unsupported", () => {
      for (const text of [
        "Saw you starred acme/widgets and raised a Seed round. A no is fine.",
        "Saw you raised a Seed round and starred acme/widgets. A no is fine.",
        "Saw you starred acme/widgets, plus the launch last week. A no is fine.",
      ]) {
        expect(lintLinkedInClose(text, { context, clause })).toContainEqual(
          expect.stringMatching(/^unsupported-claim/),
        );
      }
    });
    it("the writer turning to themselves after the clause is not a second claim", () => {
      for (const text of [
        "Saw you starred acme/widgets, so figured I'd say what we make. A no is fine.",
        "Saw you just starred acme/widgets and I wanted to say what we make.",
        "Saw you've starred acme/widgets too. A no is fine.",
      ]) {
        expect(lintLinkedInClose(text, { context, clause })).toEqual([]);
      }
    });
    it("a long run of spaces after the clause is judged quickly", () => {
      const started = Date.now();
      const text = `Saw you${" ".repeat(20_000)}starred acme/widgets${" ".repeat(50_000)}x`;
      expect(lintLinkedInClose(text, { context, clause })).toContainEqual(
        expect.stringMatching(/^unsupported-claim/),
      );
      expect(Date.now() - started).toBeLessThan(1_000);
    });
    it("a clause with a dot in it still counts", () => {
      expect(
        lintLinkedInClose("Saw you starred vercel/next.js. A no is fine.", {
          context,
          clause: "starred vercel/next.js",
        }),
      ).toEqual([]);
    });
    it("any saw-you claim is unsupported when there is no clause", () => {
      expect(lintLinkedInClose("Saw you starred acme/widgets.", { context })).toContainEqual(
        expect.stringMatching(/^unsupported-claim/),
      );
    });
  });
});

describe("repair turn", () => {
  it("a draft that fails the lint is sent back once with the findings", async () => {
    replies = [
      "See https://example.com. What now?",
      "Thanks for connecting. What are you building?",
    ];
    const out = await draftWithRepair({
      system: "prompt:linkedin-message",
      context: "ctx",
      lint: lintLinkedInFirstMessage,
      maxTokens: 100,
    });
    expect(out).toEqual({ text: "Thanks for connecting. What are you building?", flags: [] });
    expect(completions).toHaveLength(2);
    const repair = completions[1]!;
    expect(repair.at(-1)!.content).toContain("link:");
    expect(repair.some((m) => m.role === "assistant")).toBe(true);
  });

  it("a clean draft is not repaired", async () => {
    replies = ["Thanks for connecting. What are you building?"];
    const out = await draftWithRepair({
      system: "prompt:linkedin-message",
      context: "ctx",
      lint: lintLinkedInFirstMessage,
      maxTokens: 100,
    });
    expect(out.flags).toEqual([]);
    expect(completions).toHaveLength(1);
  });

  it("only one repair turn: flags left after it are returned, not hidden", async () => {
    replies = ["one", "two"];
    const out = await draftWithRepair({
      system: "prompt:linkedin-message",
      context: "ctx",
      lint: lintLinkedInFirstMessage,
      maxTokens: 100,
    });
    expect(completions).toHaveLength(2);
    expect(out.text).toBe("two");
    expect(out.flags).toContainEqual(expect.stringMatching(/^questions/));
  });
});

describe("lintAlreadyConnected", () => {
  it("flags the framing of a request they never received", () => {
    for (const [text, label] of [
      ["Thanks for connecting — how is review going?", "thanks for connecting"],
      ["Thank you for accepting. What are you shipping?", "thanks for connecting"],
      ["Saw you got my connection request a while back.", "connection request"],
      ["Following up on my invite: what is the team building?", "invite"],
      ["I sent an invite last week. What are you shipping?", "invite"],
      ["I invited you a while ago. What are you on now?", "invite"],
      ["I sent a connection invite last week. What are you shipping?", "invite"],
      ["Sent you a LinkedIn invitation earlier; what are you building?", "invite"],
      ["Appreciate you accepting my invitation.", "accepted"],
      ["Glad we connected here. What are you on now?", "glad we connected"],
      ["Great to be connected. What are you building?", "glad we connected"],
    ] as const) {
      // A sentence can match more than one pattern ("accepting my invitation" is
      // both an acceptance and an invite); any flag sends the draft to repair.
      expect(lintAlreadyConnected(text), text).toEqual(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(`^already-connected: "${label}"`)),
        ]),
      );
    }
  });

  it("leaves product talk about connecting things alone", () => {
    for (const text of [
      "We connect agents to the tools your team already uses. What are you building?",
      "Northwind's workers stay connected to the queue under backpressure, right?",
      "How do you connect a run's retries into one trace today?",
      "What are you building at Brightkiln right now?",
    ]) {
      expect(lintAlreadyConnected(text), text).toEqual([]);
    }
  });
});
