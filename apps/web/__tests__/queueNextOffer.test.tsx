import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "../src/api/client.ts";
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

function render(props: Partial<typeof base> = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DraftSection {...base} {...props} />
    </QueryClientProvider>,
  );
}
function clickNext() {
  const click = buttons.get("Use the next offer and rewrite the draft around it");
  expect(click).toBeDefined();
  click!();
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
  it("shows the button and the active position beside the angle", () => {
    for (const [index, offer] of candidates.entries()) {
      const html = render({ payload: { offer, offerCandidates: candidates } });
      expect(html).toContain("Next offer");
      expect(html).toContain(`Offer ${index + 1} of 5`);
      expect(html).toContain("Angle 1 of 5");
    }
  });

  it("hides rotation for fewer than two candidates, sent/sending rows and founder edits", () => {
    for (const props of [
      { payload: {} },
      { payload: { offer: candidates[0], offerCandidates: candidates.slice(0, 1) } },
      { status: "sent" as const },
      { isSending: true },
      { draft: { ...base.draft!, sent: true } },
      {
        payload: { offer: { ...candidates[0], editedBy: "founder" }, offerCandidates: candidates },
      },
    ]) {
      expect(render(props)).not.toContain("Next offer");
    }
    expect(
      render({ payload: { offer: { offer: "missing" }, offerCandidates: candidates } }),
    ).not.toContain("Offer 0 of");
  });

  it("disables rotation alongside the other draft actions while generating", () => {
    const html = render({ generating: true });
    const renderedButtons = html.match(/<button\b[^]*?<\/button>/g) ?? [];
    for (const label of ["Next offer", "Rotate angle", "Regenerating…", "Send now"]) {
      expect(renderedButtons.find((button) => button.includes(label))).toMatch(
        /^<button[^>]*disabled=""/,
      );
    }
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
      render({ payload: { offer: candidates[index], offerCandidates: candidates } });
      clickNext();
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
    render();
    clickNext();
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "offer saved, but the draft still carries the old one · offline. Regenerate the draft.",
      ),
    );
    expect(refresh).toHaveBeenCalledWith({ queryKey: ["queue"] });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not redraft when offer selection fails", async () => {
    vi.spyOn(api, "setQueueOffer").mockRejectedValue(new Error("already sent"));
    const redraft = vi.spyOn(api, "regenerateDraft");
    const refresh = vi.spyOn(client, "invalidateQueries");
    render();
    clickNext();
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("couldn't update the offer · already sent"),
    );
    expect(redraft).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith({ queryKey: ["queue"] });
  });
});
