/**
 * Render the brand rasters from apps/web/public/icon.svg.
 *
 * Run by hand, never in CI — CI has neither tool. The outputs are committed,
 * so a checkout needs nothing installed to build or serve the dashboard:
 *
 *   brew install librsvg          # rsvg-convert
 *   bun run --cwd apps/web brand
 *
 * Two rules that are not obvious and cost real time to rediscover:
 *
 *   1. librsvg does not parse oklch(). `fill="oklch(0.7 0.14 155)"` renders
 *      byte-identically to black — no warning. The SVGs are written in the sRGB
 *      transcriptions of the tokens for this reason, and assertColorsParsed() below
 *      fails the build if an oklch() ever creeps back in.
 *   2. rsvg-convert cannot use Host Grotesk at all. Homebrew's FreeType is
 *      built without brotli, and @fontsource-variable ships only .woff2, so it
 *      silently substitutes a default sans. That is why the one artifact with
 *      type in it — og.png — goes through headless Chrome instead, with the
 *      font inlined as base64 (Chrome's file:// origins are opaque, so a
 *      cross-file font fetch is blocked).
 *
 * The font assertion is the point of this script, not a nicety: a wordmark
 * rendered in the fallback face looks fine in isolation and wrong forever.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(WEB, "public");
const MASTER = join(PUBLIC, "icon.svg");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FONT = join(
  WEB,
  "node_modules/@fontsource-variable/host-grotesk/files/host-grotesk-latin-wght-normal.woff2",
);

/**
 * Every scratch dir this run makes, removed in main's finally. Chrome profiles
 * are the reason: without this, each `brand` run leaves several tens of MB of
 * them behind in the system temp dir.
 */
const SCRATCH: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(d);
  return d;
}

const BG = "#120f0c";
const CREAM = "#f5f1ea";
const MUTED = "#8d847d";
const GREEN = "#47b777";

/** Every raster comes from the master. Two sources is how sizes drift apart. */
const ICONS: Array<[name: string, size: number]> = [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  // The macOS dock builds a 1024 slot; without this it upscales the 512 and
  // reads soft in the dock and in Cmd-Tab.
  ["icon-1024.png", 1024],
];

const OG_W = 1280;
const OG_H = 640;

async function run(cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) {
    throw new Error(`${cmd[0]} exited ${code}\n${await new Response(p.stderr).text()}`);
  }
}

/**
 * Headless Chrome writes --screenshot and then does not reliably exit, so
 * waiting on the process hangs the script. Wait on the artifact instead and
 * kill the browser once it lands.
 */
async function runUntilFile(cmd: string[], out: string, ms = 30_000): Promise<void> {
  // Clear the target first: otherwise a previous run's file satisfies the wait
  // immediately and the "new" render is silently the old one.
  rmSync(out, { force: true });
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const size = statSync(out, { throwIfNoEntry: false })?.size ?? 0;
      if (size > 0) {
        // Let the write settle, then confirm the size stopped moving.
        await Bun.sleep(250);
        if ((statSync(out, { throwIfNoEntry: false })?.size ?? 0) === size) return;
      }
      await Bun.sleep(150);
    }
    throw new Error(`chrome produced no ${out} within ${ms}ms`);
  } finally {
    p.kill();
  }
}

const sha = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);

/**
 * Guard against the librsvg-eats-oklch failure.
 *
 * Render the master a second time with every fill stripped, so everything falls
 * back to black. If that is byte-identical to the real render, the fills never
 * parsed — which is exactly what happens if an oklch() or a var() gets back in.
 */
async function assertColorsParsed(size: number): Promise<void> {
  const dir = scratchDir("brand-probe-");
  const flat = join(dir, "flat.svg");
  const out = join(dir, "flat.png");
  writeFileSync(flat, readFileSync(MASTER, "utf8").replace(/fill="#[0-9a-f]{6}"/gi, ""));
  await run(["rsvg-convert", "-w", String(size), "-h", String(size), flat, "-o", out]);
  if (sha(out) === sha(join(PUBLIC, `icon-${size}.png`))) {
    throw new Error(
      `icon-${size}.png rendered identically with every fill stripped — the ` +
        `colours in icon.svg did not parse. librsvg reads hex only: no oklch(), no var().`,
    );
  }
}

async function main(): Promise<void> {
  if (!existsSync(MASTER)) throw new Error(`missing ${MASTER}`);

  for (const [name, size] of ICONS) {
    const out = join(PUBLIC, name);
    await run(["rsvg-convert", "-w", String(size), "-h", String(size), MASTER, "-o", out]);
    console.log(`  ${name.padEnd(22)} ${size}×${size}`);
  }
  // One probe is enough; every icon comes off the same master at the same fills.
  await assertColorsParsed(512);

  // ── og.png ────────────────────────────────────────────────────────────────
  if (!existsSync(FONT)) throw new Error(`missing ${FONT} — is @fontsource-variable installed?`);
  const fontB64 = readFileSync(FONT).toString("base64");
  const markB64 = readFileSync(MASTER).toString("base64");

  const page = (withFont: boolean): string => `<!doctype html>
<meta charset="utf-8" />
<style>
${
  withFont
    ? `@font-face{font-family:"Host Grotesk Variable";src:url(data:font/woff2;base64,${fontB64}) format("woff2");font-weight:100 900;font-display:block}`
    : ""
}
  html,body{margin:0;background:${BG}}
  .card{width:${OG_W}px;height:${OG_H}px;box-sizing:border-box;padding:104px 110px;
        display:flex;flex-direction:column;justify-content:space-between}
  .row{display:flex;align-items:center;gap:40px}
  .row img{width:148px;height:148px}
  h1{font-family:"Host Grotesk Variable",sans-serif;font-weight:600;font-size:92px;
     letter-spacing:-.035em;color:${CREAM};margin:0;line-height:1}
  h1 .dot{color:${GREEN}}
  p{font-family:"Host Grotesk Variable",sans-serif;font-size:44px;line-height:1.3;
    color:${CREAM};margin:0;max-width:30ch;letter-spacing:-.015em}
  .rule{height:7px;width:112px;background:${GREEN};border-radius:4px;margin:0 0 30px}
  footer{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:28px;
         color:${MUTED};display:flex;gap:22px;align-items:center}
  footer .sep{color:${GREEN}}
</style>
<div class="card">
  <div class="row">
    <img src="data:image/svg+xml;base64,${markB64}" alt="" />
    <h1>oneshot<span class="dot">·</span>gtm</h1>
  </div>
  <div>
    <div class="rule"></div>
    <p>Run a play, watch the queue, read the receipt.</p>
  </div>
  <footer>bunx oneshot-gtm-server <span class="sep">·</span> oneshot-gtm.com</footer>
</div>`;

  const shot = async (html: string, out: string): Promise<void> => {
    const dir = scratchDir("brand-og-");
    const src = join(dir, "og.html");
    writeFileSync(src, html);
    await runUntilFile(
      [
        CHROME,
        "--headless",
        // A fresh profile: the daily one contributes zoom, fonts and extensions,
        // or trips the singleton lock outright.
        `--user-data-dir=${scratchDir("brand-chrome-")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--hide-scrollbars",
        `--window-size=${OG_W},${OG_H}`,
        "--force-device-scale-factor=1",
        // Otherwise Chrome bakes display-dependent subpixel fringing into the PNG.
        "--disable-lcd-text",
        "--font-render-hinting=none",
        // Without this the screenshot fires on `load` and can catch the FOUT —
        // exactly the silent failure the hash check below exists to catch.
        "--virtual-time-budget=4000",
        `--screenshot=${out}`,
        `file://${src}`,
      ],
      out,
    );
  };

  const og = join(PUBLIC, "og.png");
  const probe = join(scratchDir("brand-probe-"), "nofont.png");
  await shot(page(true), og);
  await shot(page(false), probe);
  if (sha(og) === sha(probe)) {
    throw new Error(
      "og.png rendered identically with and without the @font-face block — " +
        "Host Grotesk did not load and the wordmark is in a fallback face.",
    );
  }
  console.log(`  og.png                 ${OG_W}×${OG_H}  (font verified)`);
}

try {
  await main();
} finally {
  // The browser is killed in runUntilFile's finally; give it a moment to let
  // go of its profile before the directory goes.
  await Bun.sleep(300);
  for (const d of SCRATCH) rmSync(d, { recursive: true, force: true });
}
