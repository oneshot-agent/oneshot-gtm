import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import type { CurrentMember } from "@oneshot-gtm/shared-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Route } from "../src/routes/__root.tsx";

/** The whole root layout as the router mounts it, with `/api/me` already answered. */
async function header(me: CurrentMember | null): Promise<string> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (me) queryClient.setQueryData(["me"], me);
  const router = createRouter({
    routeTree: Route,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
    // The root is mounted alone, so no page matches under it.
    defaultNotFoundComponent: () => null,
  });
  await router.load();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const found = /<header[^>]*>[\s\S]*?<\/header>/.exec(html);
  if (!found) throw new Error("the layout rendered no header");
  return found[0];
}

const VOID = new Set(["br", "hr", "img", "input"]);

/**
 * The text a phone shows: every text node in `html` with no ancestor that is
 * `display: none` below the md breakpoint. That is Tailwind's bare `hidden`
 * (`md:block` only undoes it from md up) and `sr-only`, which is not painted.
 */
function textShownBelowMd(html: string): string {
  const stack: boolean[] = [];
  let shown = "";
  for (const [, close, tag, attrs, text] of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/g)) {
    if (text !== undefined) {
      if (!stack.includes(true)) shown += text;
    } else if (close) {
      stack.pop();
    } else if (!VOID.has(tag!) && !attrs!.endsWith("/")) {
      const classes = /class="([^"]*)"/.exec(attrs!)?.[1]?.split(/\s+/) ?? [];
      stack.push(classes.includes("hidden") || classes.includes("sr-only"));
    }
  }
  return shown;
}

describe("the header names who is signed in below the md breakpoint", () => {
  it("shows the member's name on a phone", async () => {
    const html = await header({ email: "ada@example.com", name: "Ada Member", role: "member" });
    expect(textShownBelowMd(html)).toContain("Ada Member");
    // The wide line still names them; the phone copy is the one without `hidden`.
    expect(html.match(/Ada Member/g)).toHaveLength(2);
  });

  it("falls back to the email when the member has no name", async () => {
    const html = await header({ email: "noname@example.com", name: null, role: "owner" });
    expect(textShownBelowMd(html)).toContain("noname@example.com");
  });

  it("says nothing about identity when nobody is resolved", async () => {
    const html = await header(null);
    expect(html).not.toContain("signed in as");
    expect(textShownBelowMd(html)).toContain("Menu");
  });
});
