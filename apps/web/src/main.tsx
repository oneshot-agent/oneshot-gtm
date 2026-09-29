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
 * Handle demo write refusals centrally; the transport rejects before making a
 * request. Construct this inside the IS_DEMO branch so production builds omit
 * the handler and its copy.
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
      // Captured fixtures never go stale; background refetches only reread files.
      refetchOnWindowFocus: !IS_DEMO,
      // Missing fixtures cannot recover on retry; show the error immediately.
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
