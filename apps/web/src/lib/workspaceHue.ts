/**
 * Deterministic hue per workspace name, so `gtm` always looks like `gtm`.
 *
 * Lives here rather than in WorkspaceSwitcher because two things read it now:
 * the sidebar dot, and the tab icon (see documentTitle.ts / favicon.ts). One
 * implementation, or the tab and the dot disagree about which install you are
 * looking at — which is the exact confusion the colour exists to remove.
 */
export function workspaceHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
