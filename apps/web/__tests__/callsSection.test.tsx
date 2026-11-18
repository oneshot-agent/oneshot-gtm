import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CallsSettingsView } from "../src/api/client.ts";
import { CallsSection } from "../src/components/setup/CallsSection.tsx";
import type { SetupStatus } from "../src/components/setup/types.ts";
import {
  callSectionErrors,
  callSectionRequest,
  callSectionValues,
  callsSettings,
} from "../src/lib/callSettings.ts";
import { navItems } from "../src/routes/__root.tsx";

// The /setup section for the dialler, and the nav link it switches on.

const noop = () => {};
const off: CallsSettingsView = {
  enabled: false,
  cadenceStep: null,
  window: { start: "09:00", end: "17:00", weekdays: true },
  bridge: null,
};
const render = (calls: CallsSettingsView) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <CallsSection calls={calls} onDirtyChange={noop} />
    </QueryClientProvider>,
  );
const switches = (html: string) => html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];

describe("CallsSection", () => {
  it("renders off by default: no step fields, the window, the bridge read-only", () => {
    const html = render(off);
    const [enabled, step] = switches(html);
    expect(enabled).toContain('aria-checked="false"');
    expect(step).toContain('disabled=""');
    expect(html).not.toContain("Step position");
    expect(html).toContain('value="09:00"');
    expect(html).toContain('value="17:00"');
    expect(html).toContain("Ringing your phone from the dashboard needs the call bridge.");
    expect(
      html
        .match(/<input[^>]*placeholder="not set"[^>]*>/g)
        ?.every((i) => i.includes('disabled=""')),
    ).toBe(true);
  });

  it("shows the step fields when the call step is on", () => {
    const html = render({ ...off, enabled: true, cadenceStep: { position: 2, delayDays: 4 } });
    expect(html).toContain("Step position");
    expect(html).toContain('value="2"');
    expect(html).toContain('value="4"');
    // holdDays falls back to its default.
    expect(html).toContain('value="3"');
  });

  it("fills defaults when the server reports no calls object", () => {
    const status = { cfg: {} } as Pick<SetupStatus, "calls" | "cfg">;
    expect(callsSettings(status)).toEqual(off);
    const partial = { cfg: { calls: { enabled: true, window: { start: "10:00" } } } } as Pick<
      SetupStatus,
      "calls" | "cfg"
    >;
    expect(callsSettings(partial).window).toEqual({ start: "10:00", end: "17:00", weekdays: true });
  });
});

describe("Calls section request", () => {
  it("sends calls whole, the step null when off, never the bridge", () => {
    const values = { ...callSectionValues(off), enabled: true };
    expect(callSectionRequest(values, { enabled: true })).toEqual({
      calls: {
        enabled: true,
        cadenceStep: null,
        window: { start: "09:00", end: "17:00", weekdays: true },
      },
    });
    const step = { ...values, stepOn: true, position: "2", delayDays: "6", weekdays: false };
    expect(callSectionRequest(step, { stepOn: true })).toEqual({
      calls: {
        enabled: true,
        cadenceStep: { position: 2, delayDays: 6, holdDays: 3 },
        window: { start: "09:00", end: "17:00", weekdays: false },
      },
    });
    expect(callSectionRequest(values, {})).toEqual({});
  });

  it("flags a window out of order on both ends, so editing either one blocks Save", () => {
    const base = callSectionValues(off);
    // Only the start moved past the end: the error lands on the edited field.
    expect(callSectionErrors({ ...base, start: "18:00" }).start).toBe("Before the end.");
    expect(callSectionErrors({ ...base, end: "08:00" }).end).toBe("After the start.");
    expect(callSectionErrors({ ...base, start: "17:00" }).end).toBe("After the start.");
    expect(callSectionErrors(base).start).toBeNull();
    expect(callSectionErrors(base).end).toBeNull();
  });

  it("checks the step numbers and the window", () => {
    const values = { ...callSectionValues(off), stepOn: true, position: "0", end: "08:00" };
    const errors = callSectionErrors(values);
    expect(errors.position).toMatch(/2 or more/);
    expect(errors.delayDays).toBeNull();
    expect(errors.end).toBe("After the start.");
    expect(callSectionErrors({ ...values, stepOn: false, start: "9am" }).position).toBeNull();
    expect(callSectionErrors({ ...values, start: "9am" }).start).toBe("A time like 09:00.");
  });
});

describe("nav", () => {
  it("shows Calls only when calls are on, after Cadences", () => {
    expect(navItems({ calls: false }).map((n) => n.to)).not.toContain("/calls");
    const on = navItems({ calls: true }).map((n) => n.to);
    expect(on.indexOf("/calls")).toBe(on.indexOf("/cadences") + 1);
  });
});
