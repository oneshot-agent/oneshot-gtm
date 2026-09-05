import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { serveStatic } from "../src/server.ts";

/**
 * serveStatic had no cover at all. The gap that mattered: a missing dotted path
 * returned null and the caller fell through to a 200 text/plain "server
 * running" body, which the browser then tried to decode as the asset.
 */
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "serve-static-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>root</title>");
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  writeFileSync(join(dir, "manifest.webmanifest"), "{}");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "index-abc123.js"), "//");
  mkdirSync(join(dir, "nested.dir"));
});

describe("serveStatic", () => {
  it("serves a real file", async () => {
    const r = await serveStatic(dir, "/favicon.svg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("types a webmanifest correctly", async () => {
    const r = await serveStatic(dir, "/manifest.webmanifest");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("manifest+json");
  });

  it("404s a missing asset instead of handing back a text/plain body", async () => {
    const r = await serveStatic(dir, "/icon-512.png");
    expect(r.status).toBe(404);
  });

  it("keeps the SPA fallback for extension-less paths", async () => {
    const r = await serveStatic(dir, "/queue");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>root</title>");
  });

  it("404s a directory rather than failing mid-stream with EISDIR", async () => {
    expect((await serveStatic(dir, "/nested.dir")).status).toBe(404);
  });

  it("refuses to escape the static dir", async () => {
    expect((await serveStatic(dir, "/../../etc/passwd")).status).toBe(404);
  });

  it("caches hashed assets hard and everything else not at all", async () => {
    const asset = await serveStatic(dir, "/assets/index-abc123.js");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    // index.html must never be cached: a stale one points at deleted chunks.
    const index = await serveStatic(dir, "/");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    const icon = await serveStatic(dir, "/favicon.svg");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });
});
