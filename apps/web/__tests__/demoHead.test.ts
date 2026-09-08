import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  demoHeadTags,
  DEMO_OG_IMAGE,
  DEMO_TITLE,
  DEMO_URL,
  HEAD_END,
  HEAD_START,
  replaceHeadBlock,
  transformDemoHead,
} from "../vite-plugins/demo-head.ts";

/**
 * CI runs the tests but never the web build, so a build-time throw would only
 * surface on a release tag. This is the cover for that: it reads the real
 * index.html off disk and drives the real transform.
 */
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(WEB, "index.html");
const html = readFileSync(INDEX, "utf8");

describe("index.html markers", () => {
  it("still carries the block the demo build replaces", () => {
    expect(html).toContain(HEAD_START);
    expect(html).toContain(HEAD_END);
    expect(html.indexOf(HEAD_START)).toBeLessThan(html.indexOf(HEAD_END));
  });

  it("references only assets that exist in public/", () => {
    const shipped = new Set(readdirSync(join(WEB, "public")));
    const refs = [...html.matchAll(/(?:href|src)="\/([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((r) => !r.startsWith("src/"));
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(shipped).toContain(r);
  });
});

describe("transformDemoHead", () => {
  const out = transformDemoHead(html);

  it("swaps in the demo title and drops the dashboard's", () => {
    expect(out).toContain(`<title>${DEMO_TITLE}</title>`);
    expect(out).not.toContain("<title>oneshot-gtm</title>");
    expect(out).toContain(`content="${DEMO_URL}"`);
    expect(out).toContain('name="robots" content="noindex"');
  });

  it("ships an og:image, so summary_large_image is not a blank card", () => {
    expect(out).toContain(`content="${DEMO_OG_IMAGE}"`);
    expect(out).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("leaves every icon and manifest link intact", () => {
    // The sharing invariant: these live outside the marked block precisely so
    // vite can rewrite them to /demo/ before this transform runs.
    for (const rel of ["icon", "apple-touch-icon", "manifest"]) {
      expect(out).toContain(`rel="${rel}"`);
    }
    expect(out).toContain('name="theme-color"');
  });

  it("injects no root-absolute URL of its own except the absolute og:image", () => {
    // Anything the plugin emits is POST vite's URL rewrite, so a root-absolute
    // path here would stay root-absolute under /demo/ forever. Assert on the
    // injected tags themselves — index.html's own icon links are root-absolute
    // on purpose, because vite rewrites those before this ever runs.
    for (const tag of demoHeadTags()) {
      const url = /content="(\/[^"/][^"]*)"/.exec(tag);
      expect(url, `root-absolute URL in injected tag: ${tag}`).toBeNull();
    }
    expect(demoHeadTags().join("")).toContain(`content="${DEMO_OG_IMAGE}"`);
    expect(DEMO_OG_IMAGE.startsWith("https://")).toBe(true);
  });

  it("throws, loudly and by name, if the markers go missing", () => {
    expect(() => replaceHeadBlock("<head><title>x</title></head>", "y")).toThrow(
      /apps\/web\/index\.html is missing/,
    );
  });
});
