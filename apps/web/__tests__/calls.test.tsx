import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallBrief, CallListResponse, CallListRow } from "@oneshot-gtm/shared-types";
import { api } from "../src/api/client.ts";
import { briefKey, saveCall } from "../src/components/calls/DialPanel.tsx";
import { CallsView } from "../src/routes/calls.tsx";
import {
  dialKeyAction,
  dialReducer,
  logCallRequest,
  nextRow,
  OUTCOME_KEYS,
  type DialKeyEvent,
  type DialState,
} from "../src/lib/dialler.ts";

// Links need a router; the page's own logic doesn't. Render them as plain anchors.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      hash,
      children,
      className,
    }: {
      to: string;
      search?: Record<string, string>;
      hash?: string;
      children: ReactNode;
      className?: string;
    }) => (
      <a
        href={`${to}${search ? `?${new URLSearchParams(search)}` : ""}${hash ? `#${hash}` : ""}`}
        className={className}
      >
        {children}
      </a>
    ),
  };
});

const row = (over: Partial<CallListRow> = {}): CallListRow => ({
  prospectId: 1,
  name: "Dana Reyes",
  title: "COO",
  company: "Acme Dental",
  phone: "+15125551234",
  queueId: 10,
  local: { zones: ["America/Chicago"], localTime: "10:05", inWindow: true, opensAt: null },
  playName: "post-funding",
  section: "due",
  reason: "replied: interested",
  lastTouchAt: "2026-11-15T10:00:00Z",
  lastCall: null,
  ...over,
});
const data = (over: Partial<CallListResponse> = {}): CallListResponse => ({
  enabled: true,
  dialMode: "tel",
  window: { start: "09:00", end: "17:00", weekdays: true },
  due: [row()],
  list: [
    row({ prospectId: 2, name: "Sam Ortiz", section: "list", playName: null, reason: "other" }),
    row({ prospectId: 3, name: "Lee Park", section: "list", playName: null, reason: "other" }),
  ],
  ...over,
});
const brief: CallBrief = {
  opener: "Hi Dana, it's Jo from OneShot, I emailed last week.",
  offer: "A two-week pilot on your recall list.",
  questions: ["Who owns recalls today?"],
  objections: [{ objection: "No budget", answer: "The pilot is free." }],
  voicemail: "Jo from OneShot, about the recall pilot.",
  gatekeeper: "Ask for the COO.",
  flags: ["slogan-line"],
};

let client = new QueryClient();
function render(node: ReactElement): string {
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
const page = (d: CallListResponse | undefined, selected?: number) =>
  render(<CallsView data={d} selected={selected} onOpen={() => {}} />);
const key = (
  k: string,
  target: unknown = null,
  mods: Partial<DialKeyEvent> = {},
): DialKeyEvent => ({
  key: k,
  target: target as EventTarget | null,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

afterEach(() => {
  client.clear();
  client = new QueryClient();
  vi.restoreAllMocks();
});

describe("Calls page", () => {
  it("lists the Due and Call list sections", () => {
    const html = page(data());
    expect(html).toContain(">Due (1)</h2>");
    expect(html).toContain(">Call list (2)</h2>");
    for (const name of ["Dana Reyes", "Sam Ortiz", "Lee Park"]) expect(html).toContain(name);
    expect(html).toContain("replied: interested");
    expect(html).toContain("10:05 their time");
  });

  it("dials by tel: link inside the window", () => {
    const html = page(data());
    expect(html).toContain('href="tel:+15125551234"');
    expect(html).toContain("Call</a>");
  });

  it("hides Call outside their window and says when it opens", () => {
    const out = row({ local: { zones: [], localTime: "20:10", inWindow: false, opensAt: null } });
    const html = page(data({ due: [out], list: [] }));
    expect(html).toContain("calls at 09:00 their time");
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("Call</a>");
  });

  it("shows No number, with a link to the queue row when there is one", () => {
    const html = page(data({ due: [row({ phone: null })], list: [] }));
    expect(html).toContain("No number");
    expect(html).toContain('href="/prospects?q=Dana+Reyes"');
    expect(html).not.toContain("tel:");
    const bare = page(data({ due: [row({ phone: null, queueId: null })], list: [] }));
    expect(bare).toContain("No number");
    expect(bare).not.toContain("Find phone");
  });

  it("points to Setup when calls are off", () => {
    const html = page(data({ enabled: false, due: [], list: [] }));
    expect(html).toContain("Calls are off for this workspace");
    expect(html).toContain('href="/setup#calls"');
    expect(html).not.toContain("Call list");
  });

  it("opens the dial panel with the brief, outcome keys and Save & next", () => {
    client.setQueryData(briefKey({ prospectId: 2, playName: null }), brief);
    const html = page(data(), 2);
    expect(html).toContain("Hi Dana, it&#x27;s Jo from OneShot, I emailed last week.");
    expect(html).toContain("No budget");
    expect(html).toContain("Check the wording: slogan line");
    for (const o of OUTCOME_KEYS) expect(html).toContain(o.title);
    expect(html).toContain('<kbd class="font-mono text-[10px] opacity-60">0</kbd>Do not contact');
    expect(html).toContain("Save &amp; next");
    // The last row of a section, and the only due row, save without a next.
    expect(page(data(), 3)).not.toContain("Save &amp; next");
    expect(page(data(), 1)).not.toContain("Save &amp; next");
  });

  it("puts a disabled Ring my phone in the panel when the bridge is set", () => {
    const html = page(data({ dialMode: "bridge" }), 1);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Ring my phone/);
    expect(html).toContain("Ringing your phone arrives with the call bridge");
    expect(html).not.toContain("tel:");
  });
});

describe("dial keys and Save & next", () => {
  const start: DialState = { outcome: null, note: "", holdUntil: "2026-11-24" };

  it("maps 1–9 then 0 to the outcomes in list order", () => {
    expect(OUTCOME_KEYS.map((o) => o.key)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0",
    ]);
    expect(dialKeyAction(key("1"))).toEqual({ kind: "pick", outcome: "no_answer" });
    expect(dialKeyAction(key("0"))).toEqual({ kind: "pick", outcome: "do_not_contact" });
    expect(dialKeyAction(key("x"))).toBeNull();
  });

  it("leaves keys typed in the note alone, but ⌘↵ still saves", () => {
    const textarea = { tagName: "TEXTAREA" };
    expect(dialKeyAction(key("1", textarea))).toBeNull();
    expect(dialKeyAction(key("Enter", textarea))).toBeNull();
    expect(dialKeyAction(key("Enter", textarea, { metaKey: true }))).toEqual({ kind: "save" });
    expect(dialKeyAction(key("2", null, { metaKey: true }))).toBeNull();
  });

  it("a key logs its outcome and Enter moves to the next row", async () => {
    const rows = data().list;
    let state = start;
    const pick = dialKeyAction(key("2"));
    if (pick && pick.kind !== "save") state = dialReducer(state, pick);
    state = dialReducer(state, { kind: "note", note: "  left a message  " });
    expect(dialKeyAction(key("Enter"))).toEqual({ kind: "save" });

    const log = vi.fn().mockResolvedValue({});
    const open = vi.fn();
    const req = logCallRequest(state, { durationSec: 41.6, playName: null })!;
    await saveCall(log, rows[0]!, req, nextRow(rows, 2), open);
    expect(log).toHaveBeenCalledWith(2, {
      outcome: "voicemail",
      note: "left a message",
      durationSec: 42,
    });
    expect(open).toHaveBeenCalledWith(3);

    // The section's last row closes the panel.
    await saveCall(log, rows[1]!, req, nextRow(rows, 3), open);
    expect(open).toHaveBeenLastCalledWith(null);
  });

  it("does not move on when the log fails", async () => {
    const open = vi.fn();
    const log = vi.fn().mockRejectedValue(new Error("offline"));
    const req = logCallRequest({ ...start, outcome: "no_answer" }, {})!;
    await expect(saveCall(log, row(), req, row({ prospectId: 2 }), open)).rejects.toThrow(
      "offline",
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("posts the outcome, the play and the hold date only for Not now", async () => {
    expect(logCallRequest(start, {})).toBeNull();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ call: { id: 9 } }), { status: 200 }));
    const req = logCallRequest(
      { outcome: "not_now", note: "", holdUntil: "2026-12-01" },
      { playName: "post-funding" },
    )!;
    await api.logCall(1, req);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/prospects/1/call");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      outcome: "not_now",
      playName: "post-funding",
      holdUntil: "2026-12-01",
    });
    expect(
      logCallRequest({ outcome: "interested", note: "", holdUntil: "2026-12-01" }, {}),
    ).toEqual({ outcome: "interested" });
  });
});
