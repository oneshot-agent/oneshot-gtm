import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveCallView, LiveCallsResponse } from "@oneshot-gtm/shared-types";
import { LiveCallBar } from "../src/components/calls/LiveCallBar.tsx";
import { liveCallsKey } from "../src/components/calls/useLiveCalls.ts";

// The live call bar under the header, on every page: your calls with Hang up
// and Open, a teammate's read-only, and whether each is being recorded.

const privacy = vi.hoisted(() => ({ masked: false }));
vi.mock("../src/lib/privacy.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/privacy.tsx")>();
  const { applyMask } = await import("../src/lib/mask.ts");
  return {
    ...actual,
    usePrivacy: () => ({ masked: privacy.masked, setMasked: () => {} }),
    useMask: () => (kind: Parameters<typeof applyMask>[1], value: string | null | undefined) =>
      applyMask(privacy.masked, kind, value),
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      className,
    }: {
      to: string;
      search?: Record<string, string | number>;
      children: ReactNode;
      className?: string;
    }) => (
      <a
        href={`${to}?${new URLSearchParams(
          Object.entries(search ?? {}).map(([k, v]) => [k, String(v)]),
        ).toString()}`}
        className={className}
      >
        {children}
      </a>
    ),
  };
});

const NOW = new Date("2026-11-24T16:05:00Z");
let client = new QueryClient();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  client.clear();
  client = new QueryClient();
  privacy.masked = false;
  vi.useRealTimers();
});

const live = (over: Partial<LiveCallView> = {}): LiveCallView => ({
  id: 7,
  prospectId: 1,
  playName: "post-funding",
  member: "jo@acme.com",
  startedAt: "2026-11-24T16:00:00Z",
  durationSec: null,
  outcome: null,
  note: null,
  provider: "twilio",
  status: "connected",
  connectedAt: "2026-11-24T16:02:50Z",
  transcriptStatus: "pending",
  suggestion: null,
  prospectName: "Dana Reyes",
  prospectCompany: "Acme Dental",
  mine: true,
  ...over,
});
const bar = (res: LiveCallsResponse | undefined) => {
  if (res) client.setQueryData(liveCallsKey, res);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LiveCallBar />
    </QueryClientProvider>,
  );
};
const on = (calls: LiveCallView[]): LiveCallsResponse => ({ enabled: true, record: "ask", calls });

describe("the live call bar", () => {
  it("is not there without a call, calls off, or before the first read", () => {
    expect(bar(on([]))).toBe("");
    expect(bar({ enabled: false, record: false, calls: [live()] })).toBe("");
    expect(bar(undefined)).toBe("");
  });

  it("shows your call with its timer, recording state, Open and Hang up", () => {
    const html = bar(on([live()]));
    expect(html).toContain("On a call with Dana Reyes");
    expect(html).toContain("2:10");
    expect(html).toContain("● Recording");
    expect(html).toContain('href="/calls?prospect=1&amp;play=post-funding"');
    expect(html).toContain(">Open</a>");
    expect(html).toContain("Hang up");
  });

  it("says when your call isn't recorded, and Log outcome once it ended", () => {
    expect(bar(on([live({ transcriptStatus: "none" })]))).toContain("Not recording · ask first");
    client.clear();
    const ended = bar(
      on([live({ status: "ended", durationSec: 184, transcriptStatus: "ready", playName: null })]),
    );
    expect(ended).toContain("Call with Dana Reyes ended");
    expect(ended).toContain("3:04");
    expect(ended).toContain("Transcript ready");
    expect(ended).toContain('href="/calls?prospect=1"');
    expect(ended).toContain("Log outcome");
    expect(ended).not.toContain("Hang up");
  });

  it("shows a teammate's call read-only, naming them", () => {
    const html = bar(on([live({ member: "mia@acme.com", mine: false })]));
    expect(html).toContain("Mia ·");
    expect(html).toContain("On a call with Dana Reyes");
    expect(html).toContain("● Recording");
    expect(html).toContain(">Open</a>");
    expect(html).not.toContain("Hang up");
  });

  it("privacy mode masks the prospect and never names the member", () => {
    privacy.masked = true;
    const html = bar(on([live({ member: "mia@acme.com", mine: false }), live({ id: 8 })]));
    expect(html).not.toContain("Dana Reyes");
    expect(html).not.toContain("mia");
    expect(html).not.toContain("Mia");
    expect(html).toContain("teammate ·");
  });
});
