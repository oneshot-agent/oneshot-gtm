import { workspaceHue } from "./workspaceHue.ts";

/**
 * Tint the tab icon per workspace.
 *
 * Titles tell two dashboards apart once you read them; at tab-strip width you
 * mostly see the icon. The sidebar already colours its workspace dot by
 * workspaceHue(), so the tab uses the same hue for the receipt's total line —
 * one visual language for "which install is this".
 *
 * The SVG is fetched from the served /favicon.svg rather than duplicated here.
 * A copy of the mark in a TS string is a copy that drifts.
 */

/** The accent in public/favicon.svg — --ink-receipt, transcribed to sRGB. */
export const ACCENT_HEX = "#47b777";

/** oklch(0.72 0.14 h) → sRGB hex, matching WorkspaceDot's CSS exactly. */
export function hueToHex(hue: number): string {
  const L = 0.72;
  const C = 0.14;
  const h = (hue * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${lin
    .map((v) => {
      const srgb = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

export function tintSvg(svg: string, hue: number): string {
  return svg.replaceAll(ACCENT_HEX, hueToHex(hue));
}

/**
 * Swap the tab icon for a tinted copy. Silent no-op on any failure — a missing
 * or unreadable icon is not worth an error boundary, and the untinted mark is
 * already correct.
 */
export async function applyWorkspaceFavicon(workspace: string | null): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  // "default" is the unmarked case, same as the sidebar dot.
  if (!link || !workspace || workspace === "default") return;
  try {
    const res = await fetch(link.href);
    if (!res.ok) return;
    const svg = await res.text();
    if (!svg.includes(ACCENT_HEX)) return;
    link.href = `data:image/svg+xml,${encodeURIComponent(tintSvg(svg, workspaceHue(workspace)))}`;
  } catch {
    return;
  }
}
