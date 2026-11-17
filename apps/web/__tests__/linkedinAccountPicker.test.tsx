import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LinkedInAccountPicker } from "../src/components/setup/LinkedInAccountPicker.tsx";
import type { SetupCfg } from "../src/components/setup/types.ts";

const accounts = [
  { key: "wallet:a", name: "Ada", workspace: "alpha", status: "connected" },
  { key: "wallet:b", name: "Bo", workspace: "beta", status: "connected" },
];
function render(key?: string, rows = accounts) {
  const client = new QueryClient();
  client.setQueryData(["replies"], { accounts: rows });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LinkedInAccountPicker cfg={{ linkedin: { accountKey: key } } as SetupCfg} />
    </QueryClientProvider>,
  );
}

it("lists connected accounts, shows the selection, and explains ambiguity", () => {
  expect(render()).toContain("Several accounts are connected");
  expect(render()).toContain("LinkedIn sends and live profile reads are paused");
  expect(render("wallet:b")).toContain('value="wallet:b" selected=""');
  expect(render("wallet:b")).toContain("Bo · beta");
  expect(render(undefined, accounts.slice(0, 1))).toContain("Automatic: Ada");
});

it("keeps an unavailable selection visible and says how to recover", () => {
  expect(render("wallet:gone")).toContain("removed or is missing");
  const html = render("wallet:b", [accounts[0]!, { ...accounts[1]!, status: "disconnected" }]);
  expect(html).toContain("selected account is disconnected");
  expect(html).toContain("Choose a connected account here, or reconnect");
  expect(html).toContain("Bo (unavailable)");
});
