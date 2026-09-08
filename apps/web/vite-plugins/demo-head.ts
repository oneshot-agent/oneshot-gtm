/**
 * The head for the vendored build that oneshot-gtm.com serves at /demo.
 *
 * index.html is the only thing a crawler or a link unfurler ever sees at
 * /demo, since everything below it is rendered client side. `noindex` is
 * deliberate: the demo has no crawlable content and would otherwise compete
 * with the pages that do.
 *
 * Kept in its own module, importing nothing from `vite`, so the test can drive
 * it directly. That matters: CI runs the test suite but never runs the web
 * build, so a build-time throw alone would only surface on a release tag.
 *
 * This replaces a block delimited by marker comments rather than matching a
 * literal <title> string. The literal version silently no-opped the moment
 * anyone touched that line, which is a demo shipping the wrong head with a
 * green build.
 */

export const HEAD_START = "<!-- demo:head:start -->";
export const HEAD_END = "<!-- demo:head:end -->";

export const DEMO_TITLE = "The dashboard, clickable — oneshot-gtm";
export const DEMO_DESCRIPTION =
  "Click through the real oneshot-gtm dashboard over a seeded ledger: signed receipts, CAC per play, and the gates that refuse to scale a broken motion.";
export const DEMO_URL = "https://oneshot-gtm.com/demo";
/**
 * Absolute on purpose, and the ONLY absolute URL this module emits: unfurlers
 * do not resolve relative image URLs. Everything else the demo needs — the
 * icons, the manifest — stays in index.html, where vite rewrites it to /demo/
 * before this plugin ever sees the HTML.
 */
export const DEMO_OG_IMAGE = `${DEMO_URL}/og.png`;
const OG_W = 1280;
const OG_H = 640;

/** The demo's replacement for the marked block in index.html. */
export function demoHeadTags(): string[] {
  return [
    `<title>${DEMO_TITLE}</title>`,
    `<meta name="description" content="${DEMO_DESCRIPTION}" />`,
    `<meta name="robots" content="noindex" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="oneshot-gtm" />`,
    `<meta property="og:title" content="${DEMO_TITLE}" />`,
    `<meta property="og:description" content="${DEMO_DESCRIPTION}" />`,
    `<meta property="og:url" content="${DEMO_URL}" />`,
    // twitter:card was already summary_large_image with no image behind it, so
    // every unfurl rendered a large-image card that was blank.
    `<meta property="og:image" content="${DEMO_OG_IMAGE}" />`,
    `<meta property="og:image:width" content="${OG_W}" />`,
    `<meta property="og:image:height" content="${OG_H}" />`,
    `<meta property="og:image:alt" content="The oneshot-gtm dashboard: a queue of prospects with a signed receipt beside each send." />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${DEMO_OG_IMAGE}" />`,
  ];
}

/** Shown when scripting is off. Injected via vite's tags API, not a string match. */
export const NOSCRIPT_HTML = [
  '<div style="font-family:system-ui,sans-serif;color:#f5f1ea;background:#120f0c;',
  "            min-height:100vh;display:flex;flex-direction:column;justify-content:center;",
  '            gap:16px;padding:32px;max-width:44rem;margin:0 auto">',
  '  <h1 style="font-size:1.6rem;margin:0">The demo needs JavaScript.</h1>',
  '  <p style="margin:0;line-height:1.55;color:#8d847d">',
  "    It is the dashboard itself, rendered in the browser. The page that explains it reads",
  "    fine without scripting.",
  "  </p>",
  '  <p style="margin:0"><a href="https://oneshot-gtm.com" style="color:#f5f1ea">',
  "    Back to oneshot-gtm.com</a></p>",
  '  <p style="margin:0;font-family:ui-monospace,monospace;color:#8d847d">',
  "    Or run it yourself: bunx oneshot-gtm-server</p>",
  "</div>",
].join("\n    ");

export function replaceHeadBlock(html: string, next: string): string {
  const from = html.indexOf(HEAD_START);
  const to = html.indexOf(HEAD_END);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(
      `[demo-head] apps/web/index.html is missing the ${HEAD_START} … ${HEAD_END} ` +
        `markers. The demo build replaces that block wholesale — restore them, or ` +
        `update apps/web/vite-plugins/demo-head.ts to match.`,
    );
  }
  return html.slice(0, from) + next + html.slice(to + HEAD_END.length);
}

/** The whole transform, so the test exercises exactly what the build runs. */
export function transformDemoHead(html: string): string {
  return replaceHeadBlock(html, demoHeadTags().join("\n    "));
}
