import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SendHoldNote } from "../src/components/queue/WeakOfferHold.tsx";

const reason =
  "The address is at northwind.example, but person research says they work at Acme now. Fix the address or the company, or send to this address anyway.";
const render = (rowId?: number) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SendHoldNote hold={{ code: "email-mismatch", reason }} rowId={rowId} />
    </QueryClientProvider>,
  );

it("names the address hold and shows its reason", () => {
  const html = render(7);
  expect(html).toContain("Held · email mismatch");
  expect(html).toContain("northwind.example");
  expect(html).toContain("Regenerating the draft will not clear this hold.");
  expect(html).not.toContain("Held · fit review");
});

it("offers sending to this address only when the row is known", () => {
  expect(render(7)).toContain("Send to this address anyway");
  expect(render()).not.toContain("Send to this address anyway");
});
