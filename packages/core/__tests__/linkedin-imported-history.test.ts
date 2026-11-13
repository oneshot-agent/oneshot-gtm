import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

// A reply already imported from another tool (any source this install does
// not write itself) is kept as the record of that message: the inbox does not
// count it a second time. A reply the founder marked by hand is native, so it
// does not stand in for the captured message.

vi.mock("../src/workspaces.ts", async () => ({
  ...(await vi.importActual<typeof import("../src/workspaces.ts")>("../src/workspaces.ts")),
  listWorkspaces: () => [],
}));
const { Ledger } = await import("../src/ledger.ts");
const { canonicalLinkedInProfileKey } = await import("../src/ledger-prospects.ts");
const { LinkedInInboxStore } = await import("../src/linkedin-inbox.ts");

const TEXT = "Can you explain how this works?";
const SENT_AT = "2026-09-17T12:00:00Z";

function deliverAfterPrior(source: string): string[] {
  const home = join(process.env.ONESHOT_GTM_HOME!, `imported-${randomUUID()}`);
  mkdirSync(home, { recursive: true });
  const seed = new Ledger(join(home, "ledger.sqlite"));
  const prospect = seed.upsertProspect({
    email: "ada@example.test",
    name: "Ada",
    linkedin_url: "https://linkedin.com/in/ada-example",
  });
  seed.recordLinkedInReply({
    prospectId: prospect,
    source,
    externalEventId: `prior-${source}`,
    occurredAt: SENT_AT,
    body: TEXT,
  });
  seed.close();
  const store = new LinkedInInboxStore(join(home, "inbox.sqlite"));
  try {
    store.saveConversation(
      "account",
      {
        id: "one",
        attendees: [{ is_self: false, profile_url: "https://linkedin.com/in/ada-example" }],
      } as never,
      [],
    );
    store.assign("linkedin:account:one", { workspace: "test", prospectId: prospect });
    store.saveMessages("account", [
      {
        id: "one",
        conversation_id: "one",
        direction: "inbound",
        text: TEXT,
        sent_at: SENT_AT,
        deleted: false,
      },
    ] as never);
    store.deliverAll(store.threads(), [
      {
        workspace: "test",
        home,
        prospectId: prospect,
        name: "Ada",
        profile: canonicalLinkedInProfileKey("https://linkedin.com/in/ada-example")!,
      },
    ]);
  } finally {
    store.close();
  }
  const after = new Ledger(join(home, "ledger.sqlite"));
  try {
    return after
      .listChannelEventsForProspect(prospect)
      .map((e) => e.source)
      .toSorted();
  } finally {
    after.close();
  }
}

it.each(["imported-crm", "csv-import"])(
  "keeps a reply imported from %s as the only record of the message",
  (source) => {
    expect(deliverAfterPrior(source)).toEqual([source]);
  },
);

it("still records the captured message beside a reply marked by hand", () => {
  expect(deliverAfterPrior("manual")).toEqual(["manual", "oneshot-linkedin"]);
});
