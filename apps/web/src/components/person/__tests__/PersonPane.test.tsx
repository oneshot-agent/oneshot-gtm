// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PersonView, QueueDossierView } from "@oneshot-gtm/shared-types";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonPane, PersonTouches } from "../PersonPane.tsx";
import { personKey } from "../usePerson.ts";

// Privacy mode, switched per test.
const privacy = vi.hoisted(() => ({ masked: false }));
vi.mock("../../../lib/privacy.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/privacy.tsx")>();
  const { applyMask } = await import("../../../lib/mask.ts");
  return {
    ...actual,
    usePrivacy: () => ({ masked: privacy.masked, setMasked: () => {} }),
    useMask: () => (kind: Parameters<typeof applyMask>[1], value: string | null | undefined) =>
      applyMask(privacy.masked, kind, value),
  };
});

const dossier: QueueDossierView = {
  status: "complete",
  researchedAt: "2026-11-01T00:00:00Z",
  person: {
    fullName: "Ada Lovelace",
    title: "Head of AI Platform",
    company: "Analytical Engines",
    location: "London",
    summary: "Builds the agent platform.",
    linkedinUrl: "https://www.linkedin.com/in/ada-l",
    emails: [],
    phones: [],
    skills: [],
  },
  experience: [
    {
      company: "Analytical Engines",
      title: "Head",
      startDate: "Jan 2023",
      endDate: null,
      current: true,
    },
  ],
  education: [],
  company: null,
  posts: [
    {
      platform: "linkedin",
      content: "Shipped the evaluator today.",
      url: null,
      postedAt: "2026-11-20T00:00:00Z",
      likes: null,
      replies: null,
      shares: null,
      isRepost: false,
      source: "newsfeed",
    },
    {
      platform: "linkedin",
      content: "RT @someone: their words",
      url: null,
      postedAt: "2026-11-19T00:00:00Z",
      likes: null,
      replies: null,
      shares: null,
      isRepost: true,
      source: "newsfeed",
    },
  ],
  newsfeedFetchedAt: "2026-11-21T00:00:00Z",
};

const person = (over: Partial<PersonView> = {}): PersonView => ({
  prospect: {
    id: 1,
    name: "Ada Lovelace",
    email: "ada@engines.example",
    title: "Head of AI Platform",
    company: "Analytical Engines",
    linkedinUrl: "javascript:alert(1)",
    icpVerdict: null,
    icpVerdictReason: null,
  },
  queueId: 10,
  dossier,
  flags: {
    replied: true,
    bounced: false,
    contactSuppressed: null,
    breakupHold: false,
    icpReject: false,
  },
  cadences: [],
  touches: [
    {
      at: "2026-11-22T10:00:00Z",
      kind: "call",
      label: "call",
      detail: null,
      playName: "post-funding",
      channel: "call",
      call: { id: 7, outcome: "not_now", durationSec: 247, note: "Call back in Q1", member: "Jo" },
    },
    {
      at: "2026-11-21T10:00:00Z",
      kind: "sequence",
      label: "email step 2",
      detail: "Re: the evaluator",
      playName: "post-funding",
      channel: "email",
      body: "Hi Ada, a follow-up on the evaluator.",
    },
    {
      at: "2026-11-01T10:00:00Z",
      kind: "surfaced",
      label: "surfaced",
      detail: null,
      playName: "other-play",
      channel: null,
    },
  ],
  ...over,
});

let client = new QueryClient();
function seed(
  view: PersonView,
  key: { prospectId?: number; queueId?: number } = { prospectId: 1 },
) {
  client.setQueryData(personKey(key), view);
}
function html(node: ReactElement): string {
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

let root: Root | null = null;
let host: HTMLElement | null = null;
async function mount(node: ReactElement): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  client.clear();
  client = new QueryClient();
  privacy.masked = false;
});

describe("PersonPane", () => {
  it("shows who they are, the bio, every touch and a safe LinkedIn link only", () => {
    seed(person());
    const out = html(<PersonPane prospectId={1} highlightPlay="post-funding" />);
    for (const text of [
      "Ada Lovelace",
      "Head of AI Platform · Analytical Engines",
      "London",
      "replied",
      "Builds the agent platform.",
      "Head at Analytical Engines since Jan 2023",
      "Shipped the evaluator today.",
      "Full dossier",
      "email step 2",
      "Re: the evaluator",
      "other-play",
    ]) {
      expect(out).toContain(text);
    }
    // The repost is not a preview (only the full dossier lists it); the
    // prospect's bad URL falls back to the dossier's.
    const bio = out.slice(out.indexOf('aria-label="Bio"'), out.indexOf("Full dossier"));
    expect(bio).not.toContain("their words");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="https://www.linkedin.com/in/ada-l"');
  });

  it("in privacy mode keeps labels and times but no detail, bodies, bio or dossier, and opens nothing", () => {
    privacy.masked = true;
    seed(person());
    const out = html(<PersonPane prospectId={1} />);
    expect(out).toContain("email step 2");
    expect(out).toContain("Ada L.");
    expect(out).not.toContain("Ada Lovelace");
    for (const hidden of [
      "Re: the evaluator",
      "a follow-up on the evaluator",
      "Builds the agent platform.",
      "Shipped the evaluator today.",
      "Call back in Q1",
      "Full dossier",
    ]) {
      expect(out).not.toContain(hidden);
    }
    expect(out).toContain("Dossier hidden in privacy mode.");
    expect(out).not.toContain("aria-expanded");
  });

  it("offers Research only for a missing or summary-only dossier with a queue row", () => {
    const research = (view: PersonView, key: { prospectId?: number; queueId?: number }) => {
      seed(view, key);
      return html(<PersonPane {...key} />).includes(">Research</button>");
    };
    expect(research(person({ dossier: { ...dossier, status: "none" } }), { queueId: 10 })).toBe(
      true,
    );
    expect(
      research(person({ dossier: { ...dossier, status: "summary-only" } }), { queueId: 11 }),
    ).toBe(true);
    expect(research(person(), { queueId: 12 })).toBe(false);
    expect(
      research(person({ queueId: null, dossier: { ...dossier, status: "none" } }), {
        prospectId: 1,
      }),
    ).toBe(false);
    // A prospect page reads for the person's newest queue row.
    expect(research(person({ dossier: { ...dossier, status: "none" } }), { prospectId: 2 })).toBe(
      true,
    );
  });

  it('drops call touches with omit ["call"], and skips omitted parts', () => {
    seed(person());
    const full = html(<PersonPane prospectId={1} />);
    expect(full).toContain(">call</span>");
    const out = html(<PersonPane prospectId={1} omit={["call", "header"]} />);
    expect(out).toContain("email step 2");
    expect(out).not.toContain(">call</span>");
    expect(out).not.toContain(">LinkedIn<");
    const touches = html(<PersonTouches prospectId={1} omitCalls />);
    expect(touches).toContain("email step 2");
    expect(touches).not.toContain(">call</span>");
  });

  it("still shows what stops a send when the page omits the header", () => {
    seed(
      person({
        flags: {
          replied: false,
          bounced: true,
          contactSuppressed: "unsubscribe",
          breakupHold: false,
          icpReject: true,
        },
      }),
    );
    const out = html(<PersonPane prospectId={1} omit={["header"]} />);
    expect(out).toContain("hard bounce");
    expect(out).toContain("unsubscribed");
    expect(out).toContain("off-icp");
    seed(person({ flags: { ...person().flags, replied: false } }));
    expect(html(<PersonPane prospectId={1} omit={["header"]} />)).not.toContain("hard bounce");
  });

  it("offers more on a short bio spread over more lines than the clamp shows, and no clamp without it", () => {
    const lines = "one\ntwo\nthree\nfour\nfive\nsix";
    seed(person({ dossier: { ...dossier, person: { ...dossier.person, summary: lines } } }));
    const many = html(<PersonPane prospectId={1} />);
    expect(many).toContain("line-clamp-4");
    expect(many).toMatch(/aria-expanded="false"[^>]*>more</);
    seed(person({ dossier: { ...dossier, person: { ...dossier.person, summary: "short" } } }));
    expect(html(<PersonPane prospectId={1} />)).not.toContain("line-clamp-4");
  });

  it("opens a touch to show its body and a call's outcome, duration and note", async () => {
    seed(person());
    const el = await mount(<PersonPane prospectId={1} />);
    expect(el.textContent).not.toContain("a follow-up on the evaluator");
    const buttons = [...el.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")];
    const email = buttons.find((b) => b.textContent?.includes("email step 2"))!;
    const call = buttons.find((b) => b.textContent?.includes("call"))!;
    expect(email.getAttribute("aria-expanded")).toBe("false");
    await act(async () => email.click());
    expect(email.getAttribute("aria-expanded")).toBe("true");
    expect(el.textContent).toContain("Hi Ada, a follow-up on the evaluator.");
    await act(async () => call.click());
    expect(el.textContent).toContain("4:07");
    expect(el.textContent).toContain("Call back in Q1");
    expect(el.textContent).toContain("by Jo");
  });

  it("keeps the aside while the person loads", () => {
    const out = html(<PersonPane prospectId={99} aside={<a href="tel:+1">Call</a>} />);
    expect(out).toContain('href="tel:+1"');
  });
});
