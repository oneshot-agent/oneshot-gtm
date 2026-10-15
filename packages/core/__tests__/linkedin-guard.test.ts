import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkedInConversation, LinkedInMessage } from "../src/linkedin-fields.ts";
import { Ledger } from "../src/ledger.ts";
import { LinkedInInboxStore, linkedInHasConversationWith } from "../src/linkedin-inbox.ts";
import { RESERVATION_TTL_MS, SharedDb } from "../src/shared-db.ts";
import {
  canInviteOnLinkedIn,
  claimLinkedInProfile,
  describeGuardCounts,
  guardFlag,
  guardReasonOfFlag,
  looksLikePersonName,
  normalizeLinkedInProfile,
} from "../src/linkedin-guard.ts";

// Everything runs against temp files: never a real ONESHOT_GTM_HOME or shared DB.

const person = (over: Record<string, unknown> = {}) => ({
  name: "Dana Lee",
  company: "Acme",
  email: "dana@acme.com",
  linkedinUrl: "https://www.linkedin.com/in/dana-lee",
  ...over,
});
const reasonOf = (v: { ok: boolean; reason?: string }) => (v.ok ? null : v.reason);

describe("normalizeLinkedInProfile", () => {
  const clean = "https://www.linkedin.com/in/dana-lee";

  it.each([
    ["https://www.linkedin.com/in/dana-lee", clean],
    ["http://linkedin.com/in/dana-lee", clean],
    ["HTTPS://WWW.LINKEDIN.COM/in/dana-lee", clean],
    ["https://it.linkedin.com/in/dana-lee", clean],
    ["https://de.linkedin.com/in/dana-lee/", clean],
    ["https://www.linkedin.com/in/dana-lee?utm_source=share&trk=x", clean],
    ["https://www.linkedin.com/in/dana-lee#about", clean],
    ["https://www.linkedin.com/in/dana-lee/en", clean],
    ["https://www.linkedin.com/in/dana-lee/en-us/", clean],
    ["https://www.linkedin.com/in/dana-lee/pt_br", clean],
    ["  https://www.linkedin.com/in/dana-lee  ", clean],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeLinkedInProfile(raw)?.url).toBe(expected);
  });

  it("dedupes on the lowercased slug", () => {
    const a = normalizeLinkedInProfile("https://it.linkedin.com/in/Dana-Lee/en");
    const b = normalizeLinkedInProfile("https://www.linkedin.com/in/dana-lee");
    expect(a?.key).toBe("dana-lee");
    expect(a?.key).toBe(b?.key);
  });

  it("keeps the slug's percent-encoding exactly as stored", () => {
    const slug = "iskender-%E2%80%9Calex%E2%80%9D-tale-654849181";
    const p = normalizeLinkedInProfile(`https://tr.linkedin.com/in/${slug}/`);
    expect(p?.url).toBe(`https://www.linkedin.com/in/${slug}`);
    expect(p?.slug).toBe(slug);
    // Decoding would change the identity of the slug.
    expect(p?.key).toBe(slug.toLowerCase());
    expect(p?.key).not.toContain("\u201c");
  });

  it.each([
    "https://x.com/someone",
    "https://twitter.com/someone",
    "https://github.com/someone",
    "https://www.linkedin.com/company/acme",
    "https://www.linkedin.com/school/some-university",
    "https://www.linkedin.com/pub/dir/Dana/Lee",
    "https://www.linkedin.com/in/",
    "https://www.linkedin.com/in/dana-lee/details/experience",
    "https://notlinkedin.com/in/dana-lee",
    "https://linkedin.com.evil.example/in/dana-lee",
    "ftp://www.linkedin.com/in/dana-lee",
    "linkedin.com/in/dana-lee",
    "",
    null,
    undefined,
  ])("rejects %s", (raw) => {
    expect(normalizeLinkedInProfile(raw as string | null | undefined)).toBeNull();
  });
});

describe("looksLikePersonName", () => {
  it.each([
    ["SWE-agent", {}],
    ["Se7en", {}],
    ["Standard Agents", {}],
    ["Stably", { company: "Stably", email: "jinjing@stably.ai" }],
    ["x", {}],
    ["", {}],
    [null, {}],
    ["some_handle", {}],
    // A lone hyphenated token reads as a handle; refusing is recoverable (add a surname).
    ["Jean-Luc", { company: "Acme" }],
    ["user.name", {}],
    ["org/repo", {}],
    ["Acme Labs", {}],
    ["Acme Inc", {}],
    ["Foo Technologies", {}],
    ["Acme Software", {}],
    ["Dana Lee 3rd", {}],
    ["Sam Park Capital", {}],
    ["Bot", {}],
  ] as const)("rejects %s", (name, opts) => {
    expect(looksLikePersonName(name, opts)).toBe(false);
  });

  it.each([
    ["Danny Avila", { company: "danny-avila" }],
    ["Aurelio", { company: "Aureliolo", email: "aurelio.n@corp.com" }],
    ["Dana Lee", {}],
    ["Mary-Jane Watson", {}],
    ["Ai Tanaka", {}],
    ["Dana", { company: "Acme", email: "dana@acme.com" }],
    ["Ana María", {}],
    ["Zoë Müller", {}],
  ] as const)("keeps %s", (name, opts) => {
    expect(looksLikePersonName(name, opts)).toBe(true);
  });

  it("a single-token name the company echoes needs the email local part, never the domain", () => {
    // Domain contains the name: still the company's name.
    expect(looksLikePersonName("Stably", { company: "Stably", email: "jinjing@stably.ai" })).toBe(
      false,
    );
    // Company merely contains the name, mailbox is someone else's.
    expect(looksLikePersonName("Aurelio", { company: "Aureliolo", email: "x@aurelio.com" })).toBe(
      false,
    );
    expect(looksLikePersonName("Aurelio", { company: "Aureliolo" })).toBe(false);
    expect(
      looksLikePersonName("Aurelio", { company: "Aureliolo", email: "aurelio.n@corp.com" }),
    ).toBe(true);
  });

  it("compares with letters and digits only", () => {
    expect(looksLikePersonName("Stably", { company: "Stab.ly Inc." })).toBe(false);
  });

  it("multi-token names skip the echo test", () => {
    expect(looksLikePersonName("Danny Avila", { company: "Danny Avila" })).toBe(true);
    expect(looksLikePersonName("Danny Avila", { company: "dannyavila" })).toBe(true);
  });

  it("'ai' is not an org word", () => {
    expect(looksLikePersonName("Ai Lin")).toBe(true);
    expect(looksLikePersonName("Lin Ai")).toBe(true);
  });
});

describe("canInviteOnLinkedIn", () => {
  let dir: string;
  let ledger: Ledger;
  let shared: SharedDb;
  let inboxStore: LinkedInInboxStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "linkedin-guard-"));
    ledger = new Ledger(join(dir, "ledger.sqlite"));
    shared = new SharedDb(join(dir, "shared.sqlite"));
    inboxStore = new LinkedInInboxStore(join(dir, "linkedin-inbox.sqlite"));
  });
  afterEach(() => {
    ledger.close();
    shared.close();
    inboxStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const inbox = {
    hasConversationWith: (url: string) => linkedInHasConversationWith(url, inboxStore),
  };
  const check = (over: Record<string, unknown> = {}) =>
    canInviteOnLinkedIn(person(over), { ledger, shared, inbox });

  /** A synced thread on the account: `slugs` are the other attendees. */
  function thread(id: string, slugs: string[], messages: number): void {
    const conversation = {
      id,
      attendees: [
        { provider_id: "ACo-self", profile_url: null, is_self: true },
        ...slugs.map((slug, i) => ({
          provider_id: `ACo-${id}-${i}`,
          profile_url: `https://www.linkedin.com/in/${slug}`,
          is_self: false,
        })),
      ],
      attendees_synced: true,
    } as unknown as LinkedInConversation;
    inboxStore.saveConversation("account", conversation, []);
    inboxStore.saveMessages(
      "account",
      Array.from(
        { length: messages },
        (_, i) =>
          ({
            id: `${id}-m${i}`,
            conversation_id: id,
            direction: "outbound",
            sender_provider_id: "ACo-self",
            sender_name: "Me",
            text: "hello",
            sent_at: `2026-01-0${i + 1}T00:00:00Z`,
            deleted: false,
          }) as unknown as LinkedInMessage,
      ),
    );
  }

  function seed(): number {
    return ledger.upsertProspect({
      name: "Dana Lee",
      email: "dana@acme.com",
      company: "Acme",
      linkedin_url: "https://www.linkedin.com/in/dana-lee",
      source: "test",
    });
  }
  const reply = (prospectId: number, id: string, kind: string | null) =>
    ledger.recordInboxReply({
      id,
      threadKey: `t-${id}`,
      prospectId,
      fromEmail: "dana@acme.com",
      body: "hello",
      receivedAt: new Date().toISOString(),
      kind: kind as never,
    });

  it("passes a clean person with a personal profile, known or not to the ledger", () => {
    expect(check()).toEqual({ ok: true });
    seed();
    expect(check()).toEqual({ ok: true });
  });

  it("1. refuses X, GitHub and company URLs", () => {
    for (const url of [
      "https://x.com/dana",
      "https://github.com/dana",
      "https://www.linkedin.com/company/acme",
      null,
    ]) {
      expect(reasonOf(check({ linkedinUrl: url }))).toBe("invalid-profile");
    }
  });

  it("2. refuses a name that is a repo, handle or company", () => {
    for (const name of ["SWE-agent", "Se7en", "Standard Agents"]) {
      expect(reasonOf(check({ name }))).toBe("not-a-person");
    }
    expect(reasonOf(check({ name: "Stably", company: "Stably", email: "jinjing@stably.ai" }))).toBe(
      "not-a-person",
    );
  });

  it("3. refuses an opted-out person (unsubscribe reply)", () => {
    const id = seed();
    reply(id, "r1", "unsubscribe");
    expect(reasonOf(check())).toBe("opted-out");
  });

  it("4. an out-of-office reply does not block", () => {
    const id = seed();
    reply(id, "ooo", "auto");
    expect(check()).toEqual({ ok: true });
  });

  it("4. a human reply, a dead mailbox and a legacy NULL kind do block", () => {
    const id = seed();
    reply(id, "dead", "auto_permanent");
    expect(reasonOf(check())).toBe("replied");
  });

  it("4. a human email reply blocks", () => {
    const id = seed();
    reply(id, "h1", "human");
    expect(reasonOf(check())).toBe("replied");
  });

  it("4. a reply with no kind (predates the classifier) reads as human", () => {
    const id = seed();
    reply(id, "legacy", null);
    expect(reasonOf(check())).toBe("replied");
  });

  it("4. a LinkedIn reply blocks", () => {
    const id = seed();
    ledger.recordLinkedInReply({
      prospectId: id,
      source: "linkedin",
      externalEventId: "evt-1",
      occurredAt: new Date().toISOString(),
    });
    expect(reasonOf(check())).toBe("replied");
  });

  it("4. a stopped cadence blocks", () => {
    const id = seed();
    ledger.enrollCadence({ prospectId: id, playName: "luma-events", nextDueAt: "2026-01-01" });
    expect(check()).toEqual({ ok: true });
    ledger.stopCadence({ prospectId: id, playName: "luma-events", reason: "other" });
    expect(reasonOf(check())).toBe("cadence-stopped");
  });

  it("5. refuses an ICP reject, lets NULL and pass through", () => {
    const id = seed();
    expect(check()).toEqual({ ok: true });
    ledger.setProspectIcpVerdict(id, "pass");
    expect(check()).toEqual({ ok: true });
    ledger.setProspectIcpVerdict(id, "unclear");
    expect(check()).toEqual({ ok: true });
    ledger.setProspectIcpVerdict(id, "reject", "off-ICP title");
    expect(reasonOf(check())).toBe("icp-rejected");
  });

  it("5. the row's own verdict counts for a prospect not yet in the ledger", () => {
    expect(reasonOf(check({ icpVerdict: "reject" }))).toBe("icp-rejected");
  });

  it("5. a stale or unclear row verdict can't clear a stored reject; a human override can", () => {
    const id = seed();
    ledger.setProspectIcpVerdict(id, "reject", "off-ICP title");
    expect(reasonOf(check({ icpVerdict: "pass" }))).toBe("icp-rejected");
    expect(reasonOf(check({ icpVerdict: "unclear" }))).toBe("icp-rejected");
    expect(check({ icpVerdict: "pass", icpOverridden: true })).toEqual({ ok: true });
    // The row's own reject still wins over an override flag.
    expect(reasonOf(check({ icpVerdict: "reject", icpOverridden: true }))).toBe("icp-rejected");
  });

  it("7. an invite recorded before the shared table existed still excludes the profile", () => {
    const id = seed();
    ledger.recordLinkedInInviteEvent({
      prospectId: id,
      playName: "luma-events",
      stepIndex: 0,
      status: "sent",
      metadata: { invitationId: "old-1" },
    });
    // A different row, play and workspace for the same person: nothing in the shared file yet.
    expect(shared.linkedInTouch("dana-lee")).toBeNull();
    const v = canInviteOnLinkedIn(person({ email: null }), { ledger, shared, inbox });
    expect(reasonOf(v)).toBe("already-invited");
    expect(shared.linkedInTouch("dana-lee")?.status).toBe("confirmed");
    // Once only: a withdrawn-then-forgotten marker isn't re-imported over a release.
    expect(shared.importLinkedInInvites("again", () => [])).toBe(0);
  });

  it("7. a guard call never opens another workspace's ledger (that history arrives by import)", () => {
    const prevWs = process.env["ONESHOT_GTM_WORKSPACES"];
    const wsRoot = join(dir, "ws");
    const alphaHome = join(wsRoot, "alpha");
    mkdirSync(alphaHome, { recursive: true });
    writeFileSync(
      join(wsRoot, "registry.json"),
      JSON.stringify({
        default: "default",
        workspaces: { alpha: { home: alphaHome, port: 3031, createdAt: "" } },
      }),
    );
    process.env["ONESHOT_GTM_WORKSPACES"] = wsRoot;
    const alpha = new Ledger(join(alphaHome, "ledger.sqlite"));
    try {
      const old = alpha.upsertProspect({
        name: "Dana Lee",
        email: "dana@acme.com",
        company: "Acme",
        linkedin_url: "https://www.linkedin.com/in/dana-lee",
        source: "test",
      });
      alpha.recordLinkedInInviteEvent({
        prospectId: old,
        playName: "luma-events",
        stepIndex: 0,
        status: "sent",
        metadata: { invitationId: "old-alpha" },
      });
      // Repeated calls: the other ledger is neither read nor left open.
      for (let i = 0; i < 3; i++) expect(check({ email: null })).toEqual({ ok: true });
      expect(shared.linkedInTouch("dana-lee")).toBeNull();
      // The explicit import is what carries it over; the guard then refuses.
      shared.markLinkedInTouched({ slug: "dana-lee", source: "invite:alpha" });
      expect(reasonOf(check({ email: null }))).toBe("already-invited");
    } finally {
      alpha.close();
      if (prevWs === undefined) delete process.env["ONESHOT_GTM_WORKSPACES"];
      else process.env["ONESHOT_GTM_WORKSPACES"] = prevWs;
    }
  });

  it("8. refuses someone the account already has a conversation with", () => {
    thread("chat-1", ["dana-lee"], 1);
    expect(reasonOf(check())).toBe("already-in-conversation");
    // However the URL is spelled.
    expect(reasonOf(check({ linkedinUrl: "https://it.linkedin.com/in/Dana-Lee/?utm=x" }))).toBe(
      "already-in-conversation",
    );
  });

  it("8. an empty conversation, a group thread and a removed account's history do not block", () => {
    thread("empty", ["dana-lee"], 0);
    thread("group", ["dana-lee", "someone-else"], 2);
    expect(check()).toEqual({ ok: true });
    inboxStore.saveAccount({
      key: "account",
      wallet: "w",
      workspace: "alpha",
      account: { id: "a1", status: "connected", allowed_actions: [] } as never,
      sync: null,
      checkedAt: null,
      error: null,
      removedAt: "2026-01-01T00:00:00Z",
    });
    thread("gone", ["dana-lee"], 1);
    expect(check()).toEqual({ ok: true });
  });

  it("8. refuses when the synced inbox can't be read", () => {
    const v = canInviteOnLinkedIn(person(), {
      ledger,
      shared,
      inbox: {
        hasConversationWith: () => {
          throw new Error("disk I/O error");
        },
      },
    });
    expect(reasonOf(v)).toBe("guard-unavailable");
  });

  it("7. a withdrawn-only history, or another person's invite, imports nothing for this profile", () => {
    seed();
    expect(check()).toEqual({ ok: true });
  });

  it("finds the prospect by profile when the row carries no email", () => {
    const id = seed();
    reply(id, "h2", "human");
    expect(reasonOf(check({ email: null }))).toBe("replied");
  });

  it("6. refuses a profile any workspace already invited, however the URL is spelled", () => {
    const claim = shared.claimLinkedInProfile({ slug: "dana-lee", source: "invite:one" });
    shared.confirmLinkedInProfile((claim as { id: number }).id);
    const v = check({ linkedinUrl: "https://it.linkedin.com/in/Dana-Lee/en?x=1" });
    expect(reasonOf(v)).toBe("already-invited");
    expect(v.ok ? "" : v.detail).toContain("one");
  });

  it("6. an in-flight reservation holds the profile too", () => {
    shared.claimLinkedInProfile({ slug: "dana-lee", source: "invite:one" });
    expect(reasonOf(check())).toBe("already-invited");
  });

  it("7. the suppression list refuses a profile touched elsewhere", () => {
    shared.markLinkedInTouched({ slug: "dana-lee", source: "import:previous-tool" });
    const v = check();
    expect(reasonOf(v)).toBe("already-touched");
    expect(v.ok ? "" : v.detail).toContain("previous-tool");
  });

  it("refuses when the ledger can't be read (when in doubt, refuse)", () => {
    const broken = {
      resolveProspectForLinkedInReply: () => {
        throw new Error("db locked");
      },
      linkedInGuardFacts: () => null,
    };
    const v = canInviteOnLinkedIn(person(), { ledger: broken, shared, inbox });
    expect(reasonOf(v)).toBe("guard-unavailable");
  });

  it("refuses when the shared record can't be read", () => {
    const v = canInviteOnLinkedIn(person(), {
      ledger,
      inbox,
      shared: {
        linkedInTouch: () => {
          throw new Error("disk I/O error");
        },
      },
    });
    expect(reasonOf(v)).toBe("guard-unavailable");
  });
});

describe("one profile, one invite (shared DB)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "linkedin-claim-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const profile = normalizeLinkedInProfile("https://www.linkedin.com/in/dana-lee")!;

  it("two workspaces on one shared file can't both invite the same slug", () => {
    const path = join(dir, "shared.sqlite");
    const a = new SharedDb(path);
    const b = new SharedDb(path);
    try {
      const first = claimLinkedInProfile({ profile, workspace: "alpha", shared: a });
      expect(first.ok).toBe(true);
      // Reserved, not yet confirmed: the other workspace is already refused.
      const second = claimLinkedInProfile({ profile, workspace: "beta", shared: b });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.reason).toBe("already-invited");
        expect(second.detail).toContain("alpha");
      }
      if (first.ok) first.claim.confirm();
      // Confirmed: still refused, from either handle, with a differently spelled URL.
      const again = claimLinkedInProfile({
        profile: normalizeLinkedInProfile("https://fr.linkedin.com/in/DANA-LEE/en")!,
        workspace: "beta",
        shared: b,
      });
      expect(again.ok).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });

  it("a released claim frees the profile (the invite never went out)", () => {
    const db = new SharedDb(join(dir, "shared.sqlite"));
    try {
      const first = claimLinkedInProfile({ profile, workspace: "alpha", shared: db });
      if (first.ok) first.claim.release();
      expect(claimLinkedInProfile({ profile, workspace: "beta", shared: db }).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("an orphaned reservation stops holding after the TTL; a confirmed one never does", () => {
    const db = new SharedDb(join(dir, "shared.sqlite"));
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const r = db.claimLinkedInProfile({ slug: "orphan", source: "invite:x", now: t0 });
      expect("id" in r).toBe(true);
      const later = new Date(t0.getTime() + RESERVATION_TTL_MS + 1000);
      expect(db.linkedInTouch("orphan", t0)).not.toBeNull();
      expect(db.linkedInTouch("orphan", later)).toBeNull();
      // After expiry a new claim wins.
      expect(
        "id" in db.claimLinkedInProfile({ slug: "orphan", source: "invite:y", now: later }),
      ).toBe(true);

      const c = db.claimLinkedInProfile({ slug: "done", source: "invite:x", now: t0 });
      db.confirmLinkedInProfile((c as { id: number }).id);
      expect(db.linkedInTouch("done", new Date(t0.getTime() + 365 * 86_400_000))).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("a dispatched claim never expires; only an explicit release frees it", () => {
    const db = new SharedDb(join(dir, "shared.sqlite"));
    try {
      // Real clock: dispatch stamps the actual time, so "later" must be past
      // that stamp plus the reservation TTL for this to prove non-expiry.
      const t0 = new Date();
      const r = db.claimLinkedInProfile({ slug: "mid-flight", source: "invite:x", now: t0 }) as {
        id: number;
      };
      db.dispatchLinkedInProfile(r.id);
      expect(
        db.linkedInTouch("mid-flight", new Date(t0.getTime() + RESERVATION_TTL_MS + 5000)),
      ).not.toBeNull();
      const later = new Date(t0.getTime() + 30 * 86_400_000);
      expect(db.linkedInTouch("mid-flight", later)).not.toBeNull();
      expect(
        "held" in db.claimLinkedInProfile({ slug: "mid-flight", source: "invite:y", now: later }),
      ).toBe(true);
      db.releaseLinkedInProfile(r.id);
      expect(db.linkedInTouch("mid-flight", later)).toBeNull();
      // A lost reservation can't be dispatched: the caller must not send.
      expect(() => db.dispatchLinkedInProfile(r.id)).toThrow(/reservation was lost/);
    } finally {
      db.close();
    }
  });

  it("a suppression import never overwrites an existing record", () => {
    const db = new SharedDb(join(dir, "shared.sqlite"));
    try {
      db.markLinkedInTouched({ slug: "s", source: "import:first" });
      db.markLinkedInTouched({ slug: "s", source: "import:second" });
      expect(db.linkedInTouch("s")?.source).toBe("import:first");
    } finally {
      db.close();
    }
  });
});

describe("guard flags and counts", () => {
  it("round-trips a reason through its flag", () => {
    const flag = guardFlag({ ok: false, reason: "not-a-person", detail: '"X" is not a name' });
    expect(flag).toBe('not-a-person: "X" is not a name');
    expect(guardReasonOfFlag(flag)).toBe("not-a-person");
    expect(guardReasonOfFlag("note-too-long: 230/200 characters")).toBeNull();
  });

  it("describes counts largest first", () => {
    expect(describeGuardCounts({ "already-invited": 2, "not-a-person": 3 })).toBe(
      "not-a-person 3 · already-invited 2",
    );
    expect(describeGuardCounts({})).toBe("");
  });
});
