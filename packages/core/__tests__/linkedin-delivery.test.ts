import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
const opened = vi.hoisted(() => vi.fn());
vi.mock("../src/workspaces.ts", async () => ({
  ...(await vi.importActual<typeof import("../src/workspaces.ts")>("../src/workspaces.ts")),
  listWorkspaces: () => [],
}));
vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return {
    ...actual,
    Ledger: class extends actual.Ledger {
      constructor(path: string) {
        super(path);
        opened(this);
      }
    },
  };
});
const { Ledger } = await import("../src/ledger.ts");
const { canonicalLinkedInProfileKey } = await import("../src/ledger-prospects.ts");
const { LinkedInInboxStore } = await import("../src/linkedin-inbox.ts");

it.each([false, true])(
  "reuses workspace handles and closes them after delivery (failure=%s)",
  (fail) => {
    const home = join(process.env.ONESHOT_GTM_HOME!, `delivery-${randomUUID()}`);
    mkdirSync(home, { recursive: true });
    const seed = new Ledger(join(home, "ledger.sqlite"));
    const prospect = seed.upsertProspect({
      email: "ada@example.test",
      name: "Ada",
      linkedin_url: "https://linkedin.com/in/ada",
    });
    seed.close();
    opened.mockClear();
    const close = vi.spyOn(Ledger.prototype, "close");
    const record = vi.spyOn(Ledger.prototype, "recordLinkedInReply");
    if (fail)
      record.mockImplementation(() => {
        throw new Error("delivery interrupted");
      });
    const store = new LinkedInInboxStore(join(home, "inbox.sqlite"));
    try {
      const matches = [
        {
          workspace: "test",
          home,
          prospectId: prospect,
          name: "Ada",
          profile: canonicalLinkedInProfileKey("https://linkedin.com/in/ada")!,
        },
      ];
      for (const id of ["one", "two"]) {
        store.saveConversation(
          "account",
          {
            id,
            attendees: [{ is_self: false, profile_url: "https://linkedin.com/in/ada" }],
          } as never,
          [],
        );
        store.assign(`linkedin:account:${id}`, { workspace: "test", prospectId: prospect });
        store.saveMessages("account", [
          {
            id,
            conversation_id: id,
            direction: "inbound",
            text: "Can you explain how this works?",
            sent_at: "2026-09-17T12:00:00Z",
            deleted: false,
          },
        ] as never);
      }
      const deliver = () => store.deliverAll(store.threads(), matches);
      if (fail) expect(deliver).toThrow("delivery interrupted");
      else deliver();
      expect(opened).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(fail ? 1 : 2);
    } finally {
      store.close();
      close.mockRestore();
      record.mockRestore();
    }
  },
);
