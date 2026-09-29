import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { FitHold } from "../src/components/queue/FitHold.tsx";
const privacy = vi.hoisted(() => ({ masked: false }));
vi.mock("../src/lib/privacy.tsx", () => ({ usePrivacy: () => privacy }));
const render = () =>
  renderToStaticMarkup(
    createElement(FitHold, { hold: { code: "off-icp", reason: "Private fit reason" } }),
  );
it("explains the hold and why regeneration cannot clear it", () => {
  const html = render();
  expect(html).toContain("Private fit reason");
  expect(html).toContain("Held · fit review");
  expect(html).toContain("Regenerating the draft will not clear");
});
it("masks the saved assessment", () => {
  privacy.masked = true;
  try {
    expect(render()).not.toContain("Private fit reason");
  } finally {
    privacy.masked = false;
  }
});
