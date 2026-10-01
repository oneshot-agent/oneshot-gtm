import type { SendDeliveryView } from "@oneshot-gtm/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeliveryBadge, DeliveryWarning, deliveryWarningText } from "../DeliveryWarning.tsx";

const base: SendDeliveryView = {
  status: "duplicate",
  expected: 1,
  observed: 3,
  deliveredAt: ["2026-09-29T02:00:14.000Z", "2026-09-29T02:00:38.000Z", "2026-09-29T02:01:18.000Z"],
  sentAt: "2026-09-29T01:59:02.000Z",
  checkedAt: "2026-09-29T02:10:00.000Z",
  transport: "smartlead",
  identity: "smartlead:jn@mail.example",
  error: null,
};

describe("DeliveryWarning", () => {
  it("says how many times a duplicate was delivered", () => {
    expect(deliveryWarningText(base)).toBe("Delivered 3× by the mail provider");
    const html = renderToStaticMarkup(<DeliveryWarning delivery={base} />);
    expect(html).toContain("Delivered 3× by the mail provider");
    expect(html).toContain("3");
    expect(renderToStaticMarkup(<DeliveryBadge delivery={base} />)).toContain("delivered 3×");
  });

  it("flags a send with no copy in Sent, more softly", () => {
    const missing = { ...base, status: "not_found" as const, observed: 0, deliveredAt: [] };
    expect(deliveryWarningText(missing)).toBe("Not found in Sent");
    expect(renderToStaticMarkup(<DeliveryBadge delivery={missing} />)).toContain("not in Sent");
  });

  it("words a keyed send's verdicts by its one Message-ID", () => {
    const missing = {
      ...base,
      status: "not_found" as const,
      observed: 0,
      deliveredAt: [],
      keyed: true,
    };
    expect(deliveryWarningText(missing)).toBe("Accepted, but not found in Sent");
    expect(renderToStaticMarkup(<DeliveryWarning delivery={missing} />)).toContain(
      "It was not resent.",
    );
    const dup = renderToStaticMarkup(<DeliveryWarning delivery={{ ...base, keyed: true }} />);
    expect(dup).toContain("same Message-ID");
    expect(dup).not.toContain("got every copy");
  });

  it("renders nothing for a clean or missing check", () => {
    const clean = { ...base, status: "ok" as const, observed: 1 };
    expect(deliveryWarningText(clean)).toBeNull();
    expect(renderToStaticMarkup(<DeliveryWarning delivery={clean} />)).toBe("");
    expect(renderToStaticMarkup(<DeliveryBadge delivery={null} />)).toBe("");
  });
});
