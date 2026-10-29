import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueueStatusChips } from "../src/routes/queue.tsx";
import type { QueueStatusFilter } from "../src/lib/queue-helpers.ts";

// Capture each chip's handler by its visible label; keep the real Button.
const clicks = vi.hoisted(() => new Map<string, () => void>());
vi.mock("../src/components/primitives/Button.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/primitives/Button.tsx")>();
  return {
    Button: (props: ComponentProps<typeof actual.Button>) => {
      const label = renderToStaticMarkup(<>{props.children}</>).replace(/<[^>]+>/g, "|");
      const name = label.split("|").find((part) => part.trim() !== "") ?? "";
      if (props.onClick) clicks.set(name, () => props.onClick!(null!));
      return <actual.Button {...props} />;
    },
  };
});

const counts = { pending: 9, approved: 4, rejected: 2, sent: 1, expired: 0 };

function chips(statusFilter: QueueStatusFilter, noStrongOffer?: number, onSelect = () => {}) {
  return renderToStaticMarkup(
    <QueueStatusChips
      statusFilter={statusFilter}
      counts={counts}
      noStrongOffer={noStrongOffer}
      onSelect={onSelect}
    />,
  );
}

/** The chip whose label is `label`, as rendered markup. */
function chip(html: string, label: string): string {
  const found = html.split("</button>").find((b) => b.includes(`>${label}<`));
  if (!found) throw new Error(`no chip ${label}`);
  return found;
}

describe("QueueStatusChips", () => {
  it("shows the no-strong-offer count beside Pending, which counts the rest", () => {
    const html = chips("pending", 3);
    expect(chip(html, "No strong offer")).toContain(">3<");
    expect(chip(html, "pending")).toContain(">6<");
    expect(chip(html, "pending")).toContain('aria-pressed="true"');
    expect(chip(html, "No strong offer")).toContain('aria-pressed="false"');
    // Chips are in order: Pending, then No strong offer, then Approved.
    expect(html.indexOf(">pending<")).toBeLessThan(html.indexOf(">No strong offer<"));
    expect(html.indexOf(">No strong offer<")).toBeLessThan(html.indexOf(">approved<"));
  });

  it("marks the no-strong-offer view pressed and selects it on click", () => {
    const onSelect = vi.fn();
    const html = chips("no-offer", 3, onSelect);
    expect(chip(html, "No strong offer")).toContain('aria-pressed="true"');
    expect(chip(html, "pending")).toContain('aria-pressed="false"');
    clicks.get("No strong offer")!();
    expect(onSelect).toHaveBeenCalledWith("no-offer");
  });

  it("hides the chip with no rows, and counts every pending row under Pending", () => {
    const html = chips("pending");
    expect(html).not.toContain(">No strong offer<");
    expect(chip(html, "pending")).toContain(">9<");
  });

  it("keeps an empty no-strong-offer view's chip while it is the open view", () => {
    expect(chip(chips("no-offer", 0), "No strong offer")).toContain(">0<");
  });
});
