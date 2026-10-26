import type { ComponentProps, ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "../src/api/client.ts";
import { ProspectOffer } from "../src/components/queue/ProspectOffer.tsx";
import { clearRowActivity, setRowActivity } from "../src/lib/rowActivity.ts";
import { DraftSection } from "../src/routes/queue.tsx";

// Capture the rendered button's handler; keep the real component and mutation lifecycle.
const buttons = vi.hoisted(() => new Map<string, () => void>());
vi.mock("../src/components/primitives/Button.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/primitives/Button.tsx")>();
  return {
    Button: (props: ComponentProps<typeof actual.Button>) => {
      if (props.title && props.onClick) buttons.set(props.title, () => props.onClick!(null!));
      return <actual.Button {...props} />;
    },
  };
});

const NEXT = "Use the next offer and rewrite the draft around it";
const APPROVE = "Send this offer as it stands, although it was rated a weak fit";
const candidates = ["one", "two", "three", "four", "five"].map((offer) => ({
  offer,
  steps: "a, b",
}));
const base: ComponentProps<typeof DraftSection> = {
  id: 5,
  channel: "email",
  sender: "api",
  payload: { offer: candidates[0], offerCandidates: candidates },
  status: "approved",
  draft: {
    subject: "Hello",
    body: "Offer one",
    flags: [],
    sent: false,
    receiptIds: [],
    dryRun: true,
    draftedAt: "2026-10-19T00:00:00Z",
    angle: {
      text: "Why",
      origin: "configured",
      index: 0,
      count: 5,
      fingerprint: "one",
      history: [],
    },
  },
  draftedAt: null,
  generating: false,
  isSending: false,
  prospectId: null,
};
let client: QueryClient;

function wrap(node: ReactElement): string {
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
function letter(props: Partial<typeof base> = {}) {
  return wrap(<DraftSection {...base} {...props} />);
}
function offerBlock(payload: unknown = base.payload, editable = true) {
  return wrap(<ProspectOffer rowId={5} payload={payload} editable={editable} />);
}
function click(title: string) {
  const handler = buttons.get(title);
  expect(handler).toBeDefined();
  handler!();
}
/** The offer block's action row: every button but the Other offers list's Use this offer. */
function buttonLabels(html: string): string[] {
  return (html.match(/<button\b[^]*?<\/button>/g) ?? [])
    .map((b) =>
      [...b.matchAll(/>([^<]*)</g)]
        .map((m) => m[1])
        .join("")
        .trim(),
    )
    .filter((label) => label !== "Use this offer");
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  buttons.clear();
  vi.spyOn(toast, "success").mockImplementation(() => "toast");
  vi.spyOn(toast, "error").mockImplementation(() => "toast");
});
afterEach(() => {
  client.clear();
  vi.restoreAllMocks();
});

describe("queue Next offer", () => {
  it("sits in the offer block between Edit offer and New offers, not in the letter", () => {
    const block = offerBlock();
    expect(buttonLabels(block)).toEqual(["Edit offer", "Next offer", "New offers"]);
    const html = letter();
    expect(html).not.toContain("Next offer");
    expect(html).toContain("Angle 1 of 5");
    // The position is the offer header's to say.
    expect(html).not.toContain("Offer 1 of 5");
  });

  it("hides rotation for fewer than two candidates, a row that cannot change and founder edits", () => {
    for (const html of [
      offerBlock({}),
      offerBlock({ offer: candidates[0], offerCandidates: candidates.slice(0, 1) }),
      offerBlock(base.payload, false),
      offerBlock({ offer: { ...candidates[0], editedBy: "founder" }, offerCandidates: candidates }),
    ]) {
      expect(html).not.toContain("Next offer");
    }
  });

  it("locks rotation with the other offer controls while the row is busy", () => {
    const token = setRowActivity(5, "Rewriting the draft…");
    const html = offerBlock();
    clearRowActivity(5, token);
    const rendered = html.match(/<button\b[^]*?<\/button>/g) ?? [];
    for (const label of ["Edit offer", "Next offer", "New offers"]) {
      expect(rendered.find((button) => button.includes(label))).toMatch(/^<button[^>]*disabled=""/);
    }
    // Named once, on the letter's working line, not in the offer block.
    expect(html).not.toContain("Rewriting the draft…");
  });

  it("selects the next candidate before redrafting, preserves the list and refreshes the row", async () => {
    const calls: string[] = [];
    vi.spyOn(api, "setQueueOffer").mockImplementation(async () => {
      calls.push("select");
      return {} as Awaited<ReturnType<typeof api.setQueueOffer>>;
    });
    vi.spyOn(api, "regenerateDraft").mockImplementation(async () => {
      calls.push("redraft");
      return {} as Awaited<ReturnType<typeof api.regenerateDraft>>;
    });
    const refresh = vi.spyOn(client, "invalidateQueries");
    const original = JSON.stringify(candidates);
    for (let index = 0; index < candidates.length; index++) {
      offerBlock({ offer: candidates[index], offerCandidates: candidates });
      click(NEXT);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(index + 1));
      expect(api.setQueueOffer).toHaveBeenLastCalledWith(5, { select: (index + 1) % 5 });
    }
    expect(calls).toEqual(Array.from({ length: 5 }, () => ["select", "redraft"]).flat());
    expect(api.regenerateDraft).toHaveBeenLastCalledWith(5);
    expect(JSON.stringify(candidates)).toBe(original);
    expect(refresh).toHaveBeenLastCalledWith({ queryKey: ["queue"] });
    expect(toast.success).toHaveBeenCalledWith("offer saved · draft rewritten around it, not sent");
  });

  it("reports the saved offer when the draft rewrite fails and refreshes the row", async () => {
    vi.spyOn(api, "setQueueOffer").mockResolvedValue(
      {} as Awaited<ReturnType<typeof api.setQueueOffer>>,
    );
    vi.spyOn(api, "regenerateDraft").mockRejectedValue(new Error("offline"));
    const refresh = vi.spyOn(client, "invalidateQueries");
    offerBlock();
    click(NEXT);
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "offer saved, but the draft still carries the old one · offline. Regenerate the draft.",
      ),
    );
    expect(refresh).toHaveBeenCalledWith({ queryKey: ["queue"] });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("skips weak offers to the next one that is not, and goes in order when all are weak", async () => {
    vi.spyOn(api, "setQueueOffer").mockResolvedValue(
      {} as Awaited<ReturnType<typeof api.setQueueOffer>>,
    );
    vi.spyOn(api, "regenerateDraft").mockResolvedValue(
      {} as Awaited<ReturnType<typeof api.regenerateDraft>>,
    );
    const refresh = vi.spyOn(client, "invalidateQueries");
    const labelled = candidates.map((c, i) => ({
      ...c,
      relevance: i === 3 ? ("relevant" as const) : ("weak" as const),
    }));
    offerBlock({ offer: labelled[0], offerCandidates: labelled });
    click(NEXT);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(api.setQueueOffer).toHaveBeenLastCalledWith(5, { select: 3 });
    const allWeak = candidates.map((c) => ({ ...c, relevance: "weak" as const }));
    offerBlock({ offer: allWeak[0], offerCandidates: allWeak });
    click(NEXT);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(api.setQueueOffer).toHaveBeenLastCalledWith(5, { select: 1 });
  });

  it("does not redraft when offer selection fails", async () => {
    vi.spyOn(api, "setQueueOffer").mockRejectedValue(new Error("already sent"));
    const redraft = vi.spyOn(api, "regenerateDraft");
    const refresh = vi.spyOn(client, "invalidateQueries");
    offerBlock();
    click(NEXT);
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("couldn't update the offer · already sent"),
    );
    expect(redraft).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith({ queryKey: ["queue"] });
  });
});

describe("queue weak offer", () => {
  const weak = { ...candidates[0], relevance: "weak" };
  const payload = { offer: weak, offerCandidates: [weak, ...candidates.slice(1)] };
  const hold = {
    code: "weak-offer" as const,
    reason: "The offer was rated a weak fit for this firm.",
  };

  it("has one Approve offer, in the offer block, after New offers", () => {
    expect(buttonLabels(offerBlock(payload))).toEqual([
      "Edit offer",
      "Next offer",
      "New offers",
      "Approve offer",
    ]);
    const html = letter({
      payload,
      sendHold: hold,
      draft: { ...base.draft!, flags: ["weak-offer"] },
    });
    expect(html).not.toContain("Approve offer");
  });

  it("hides Approve once the offer is approved or the founder's own", () => {
    for (const offer of [
      { ...weak, weakApprovedAt: "2026-10-22T00:00:00Z" },
      { ...weak, editedBy: "founder" },
    ]) {
      expect(offerBlock({ offer, offerCandidates: candidates })).not.toContain("Approve offer");
    }
  });

  it("approves without a redraft and refreshes the row", async () => {
    vi.spyOn(api, "setQueueOffer").mockResolvedValue(
      {} as Awaited<ReturnType<typeof api.setQueueOffer>>,
    );
    const redraft = vi.spyOn(api, "regenerateDraft");
    const refresh = vi.spyOn(client, "invalidateQueries");
    offerBlock(payload);
    click(APPROVE);
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("offer approved · the draft can be sent"),
    );
    expect(api.setQueueOffer).toHaveBeenCalledWith(5, { approveWeak: true });
    expect(redraft).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith({ queryKey: ["queue"] });
  });

  it("says the hold once: the held note, not a second held line for the same flag", () => {
    const html = letter({
      payload,
      sendHold: hold,
      draft: { ...base.draft!, flags: ["weak-offer"] },
    });
    expect(html).toContain("Held · weak offer · approve the offer, pick another or rewrite it");
    expect(html).not.toContain("the offer was rated a weak fit");
    expect(html).not.toContain(hold.reason);
    expect(html).not.toContain("send as-is");
  });
});

describe("queue held line", () => {
  it("points a writer's skip at the offer block, with no note under the body", () => {
    const html = letter({
      payload: {},
      offerSkip: { why: "They left the firm in October.", at: "2026-10-22T00:00:00.000Z" },
      draft: { ...base.draft!, flags: ["no-offer"] },
    });
    expect(html).toContain("the writer found no offer to make");
    expect(html).toContain("write the offer or ask for new ones");
    expect(html).not.toContain('role="note"');
    expect(html).not.toContain("No offer: They left the firm");
    expect(html).toContain("held · write the offer or ask for new ones");
  });

  it("offers send anyway for a read-only flag on an approved row, approve on a pending one", () => {
    const draft = { ...base.draft!, flags: ["stale-event"] };
    expect(letter({ draft })).toContain("read it once more, then send anyway");
    expect(letter({ draft, status: "pending" })).toContain("approve to send");
  });

  it("never says send where the page has no Send: a hand-sent row or a send hold", () => {
    const draft = { ...base.draft!, flags: ["stale-event"] };
    const fitHold = { code: "off-icp" as const, reason: "Not who you sell to." };
    for (const html of [
      letter({ draft, sender: "manual" }),
      letter({ draft, sendHold: fitHold }),
    ]) {
      expect(html).toContain("· regenerate the draft");
      expect(html).not.toContain("send anyway");
      expect(html).not.toContain("approve to send");
    }
  });
});
