import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SendHoldNote } from "../src/components/queue/WeakOfferHold.tsx";

const reason =
  "The offer was rated a weak fit for this firm. Rewrite it, pick another, or approve it.";
const render = (code: "weak-offer" | "off-icp", editable?: boolean) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SendHoldNote
        rowId={1}
        hold={{ code, reason }}
        {...(editable !== undefined ? { editable } : {})}
      />
    </QueryClientProvider>,
  );

it("explains a weak-offer hold and offers to approve the offer", () => {
  const html = render("weak-offer");
  expect(html).toContain("Held · weak offer");
  expect(html).toContain(reason);
  expect(html).toContain("Regenerating the draft will not clear this hold");
  expect(html).toContain("Approve offer");
});

it("hides the approval while the row cannot change", () => {
  expect(render("weak-offer", false)).not.toContain("Approve offer");
});

it("keeps the fit hold for an off-ICP row", () => {
  const html = render("off-icp");
  expect(html).toContain("Held · fit review");
  expect(html).not.toContain("Approve offer");
});
