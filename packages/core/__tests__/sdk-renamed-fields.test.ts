import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonDossierResult } from "@oneshot-agent/sdk";
import { dossierAsResearch } from "../src/oneshot.ts";
import { withLegacyLinkedInNames } from "../src/linkedin-fields.ts";
import { LinkedInInboxStore } from "../src/linkedin-inbox.ts";

describe("dossierAsResearch", () => {
  it("puts the SDK 0.52 dossier back in the shape the research readers use", () => {
    const dossier: PersonDossierResult = {
      status: "completed",
      result: {
        profile: {
          state: "found",
          data: {
            full_name: "Ada Example",
            linkedin_url: "https://www.linkedin.com/in/ada-example",
            best_work_email: "ada@alpha.test",
            experience: [{ company: { name: "Alpha" }, title: { name: "CTO" } }],
            social_accounts: [],
          },
        },
        social_accounts: { state: "none", data: [] },
        articles: {
          state: "found",
          data: [{ title: "A talk", url: null, source: null, published_date: null, snippet: null }],
        },
        posts: { state: "unavailable", data: [] },
        summary: "Ada runs engineering at Alpha.",
      },
      request_id: "req_1",
      completed_at: "2026-10-15T00:00:00Z",
      cost: 0.05,
    };
    const r = dossierAsResearch(dossier);
    expect(r.result.enrichment.full_name).toBe("Ada Example");
    expect(r.result.enrichment.experience).toEqual([
      { company: { name: "Alpha" }, title: { name: "CTO" } },
    ]);
    expect(r.result.articles).toHaveLength(1);
    expect(r.result.dossier.summary).toBe("Ada runs engineering at Alpha.");
    expect(r).toMatchObject({ status: "completed", request_id: "req_1", cost: 0.05 });
  });
});

describe("withLegacyLinkedInNames", () => {
  it("adds the old LinkedIn field names beside the renamed ones, at any depth", () => {
    const page = withLegacyLinkedInNames({
      messages: [{ id: "m1", external_message_id: "x1", sender_external_id: "s1" }],
      coverage: { history_sync_status: "done", history_sync_completed_at: "2026-10-15" },
      conversations: [{ external_chat_id: "c1", attendees: [{ external_id: "a1" }] }],
    });
    expect(page.messages[0]).toMatchObject({ provider_message_id: "x1", sender_provider_id: "s1" });
    expect(page.coverage).toMatchObject({
      provider_history: "done",
      provider_history_completed_at: "2026-10-15",
    });
    expect(page.conversations[0]).toMatchObject({
      provider_chat_id: "c1",
      attendees: [{ provider_id: "a1", external_id: "a1" }],
    });
  });

  it("never overwrites an old name that is already there", () => {
    expect(withLegacyLinkedInNames({ external_id: "new", provider_id: "old" })).toEqual({
      external_id: "new",
      provider_id: "old",
    });
  });
});

describe("LinkedInInboxStore", () => {
  it("gives rows saved with only the renamed fields their old names when it opens", () => {
    const path = join(mkdtempSync(join(tmpdir(), "li-inbox-")), "inbox.sqlite");
    new LinkedInInboxStore(path).close();
    const raw = new LinkedInInboxStore(path);
    raw.db.run("INSERT INTO messages VALUES(?,?,?,?)", [
      "acct",
      "m1",
      "c1",
      JSON.stringify({ id: "m1", external_message_id: "x1", sender_external_id: "s1" }),
    ]);
    raw.close();
    const store = new LinkedInInboxStore(path);
    const row = store.db.query<{ data: string }, []>("SELECT data FROM messages").get()!;
    expect(JSON.parse(row.data)).toMatchObject({
      provider_message_id: "x1",
      sender_provider_id: "s1",
    });
    store.close();
  });
});
