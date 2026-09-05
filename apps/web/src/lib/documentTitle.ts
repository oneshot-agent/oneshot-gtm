import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { IS_DEMO } from "../api/demo.ts";

/**
 * The tab title.
 *
 * Every route used to read "oneshot-gtm", which is unusable in the way this is
 * actually run: several workspaces open at once, each its own server on its own
 * port, all of them identical in the tab strip. Routes declare a label in
 * `staticData.title`; this composes the rest in one place.
 */
export const SUFFIX = "oneshot·gtm";

/**
 * `Queue · sdk · oneshot·gtm`.
 *
 * The workspace segment is dropped for `default` and for the demo — matching
 * WorkspaceSwitcher's dot, which also treats the default install as the
 * unmarked case rather than colouring it.
 */
export function composeTitle(page: string | null, workspace: string | null): string {
  const parts = [page?.trim(), workspace?.trim(), SUFFIX].filter(
    (p): p is string => !!p && p !== "default",
  );
  // De-dupe so a page that is already the suffix ("oneshot·gtm") does not
  // render twice.
  return [...new Set(parts)].join(" · ");
}

/**
 * The deepest matched route's declared title.
 *
 * A route may declare a function instead of a string when the useful title is
 * in the params — `/run/$playName` wants the play, not the word "Run". Keeping
 * that in the same field means one mechanism, not two.
 */
export function resolveRouteTitle(
  title: RouteTitle | undefined,
  params: Record<string, string>,
): string | null {
  if (typeof title === "function") return title(params) || null;
  return typeof title === "string" && title.length > 0 ? title : null;
}

export type RouteTitle = string | ((params: Record<string, string>) => string);

export function useRouteTitle(): string | null {
  return useRouterState({
    select: (s) => {
      for (let i = s.matches.length - 1; i >= 0; i--) {
        const m = s.matches[i];
        if (!m) continue;
        const t = resolveRouteTitle(
          m.staticData?.title,
          (m.params ?? {}) as Record<string, string>,
        );
        if (t) return t;
      }
      return null;
    },
  });
}

export function useDocumentTitle(workspace: string | null): void {
  const page = useRouteTitle();
  useEffect(() => {
    document.title = composeTitle(page, IS_DEMO ? null : workspace);
  }, [page, workspace]);
}
