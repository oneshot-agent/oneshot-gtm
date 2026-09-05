import "./styles.css";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { IS_DEMO, isDemoReadOnly } from "./api/demo.ts";
import type { RouteTitle } from "./lib/documentTitle.ts";
import { routeTree } from "./routeTree.gen.ts";

/*
 * One handler for every write in the app.
 *
 * The demo transport throws before a request is made, so a refused mutation
 * always lands here rather than half-applying. Catching it once at the cache
 * means the 29 useMutation sites report the refusal identically and none of
 * them has to know demo mode exists.
 *
 * Built inside the branch, not merely guarded by it: `IS_DEMO` folds to a
 * constant at build time, so the real dashboard drops this handler and its
 * copy rather than shipping a callback that can never fire.
 */
const mutationCache = IS_DEMO
  ? new MutationCache({
      onError: (err) => {
        if (!isDemoReadOnly(err)) return;
        toast("Read-only demo", {
          description: "This action runs for real on your own install.",
        });
      },
    })
  : undefined;

const queryClient = new QueryClient({
  ...(mutationCache ? { mutationCache } : {}),
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // A captured response cannot go stale, and a demo left open in a
      // background tab should not wake up to re-read files it already holds.
      refetchOnWindowFocus: !IS_DEMO,
      // A file that 404s will 404 again. Retrying it three times on a backoff
      // only holds the route on its loading skeleton for ten seconds before
      // telling the visitor anything, which reads as a demo that hangs rather
      // than one with a gap in it.
      ...(IS_DEMO ? { retry: false } : {}),
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  // The demo is vendored into the site at /demo, so the router's idea of the
  // root has to match vite's base or every Link would point a directory up.
  ...(IS_DEMO ? { basepath: "/demo" } : {}),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  // Every route declares its tab title here; useDocumentTitle composes the rest.
  interface StaticDataRouteOption {
    title?: RouteTitle;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
