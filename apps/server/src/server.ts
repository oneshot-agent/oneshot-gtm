import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeMetrics } from "./api/home.ts";
import { listCadences, getCadence, stopCadence } from "./api/cadences.ts";
import { listReceipts, getReceipt } from "./api/receipts.ts";
import { listPlays } from "./api/plays.ts";
import { measureCac, measureRocs, recordOutcome } from "./api/measure.ts";
import { setup, getSetupStatus } from "./api/setup.ts";
import { doctor } from "./api/doctor.ts";
import { runPlay } from "./api/run.ts";
import {
  approveAllRoute,
  approveQueueRoute,
  drainQueueRoute,
  listQueueRoute,
  rejectQueueRoute,
} from "./api/queue.ts";

interface ServerOptions {
  port: number;
}

interface RouteHandler {
  (req: Request, params: Record<string, string>): Promise<Response> | Response;
}

interface RouteEntry {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

function route(method: string, pattern: string, handler: RouteHandler): RouteEntry {
  const paramNames: string[] = [];
  const regexStr = pattern.replace(/:(\w+)/g, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler };
}

const routes: RouteEntry[] = [
  route("GET", "/api/home", homeMetrics),
  route("GET", "/api/cadences", listCadences),
  route("GET", "/api/cadences/:id", getCadence),
  route("POST", "/api/cadences/:id/stop", stopCadence),
  route("GET", "/api/receipts", listReceipts),
  route("GET", "/api/receipts/:id", getReceipt),
  route("GET", "/api/plays", listPlays),
  route("GET", "/api/measure/cac", measureCac),
  route("GET", "/api/measure/rocs", measureRocs),
  route("POST", "/api/measure/outcome", recordOutcome),
  route("GET", "/api/setup", getSetupStatus),
  route("POST", "/api/setup", setup),
  route("GET", "/api/doctor", doctor),
  route("POST", "/api/run/:playName", runPlay),
  route("GET", "/api/queue", listQueueRoute),
  route("POST", "/api/queue/approve-all", approveAllRoute),
  route("POST", "/api/queue/drain", drainQueueRoute),
  route("POST", "/api/queue/:id/approve", approveQueueRoute),
  route("POST", "/api/queue/:id/reject", rejectQueueRoute),
];

function findRoute(req: Request): { handler: RouteHandler; params: Record<string, string> } | null {
  const url = new URL(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? "");
    });
    return { handler: r.handler, params };
  }
  return null;
}

function getStaticDir(): string | null {
  // Layouts we might run from:
  //   1. Source dev:   apps/server/src/server.ts → ../../web/dist
  //   2. Bundle:       apps/server/dist/bin.mjs  → ../../web/dist
  //   3. npm publish:  <pkg>/dist/bin.mjs       → ./web (we copy apps/web/dist here)
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "..", "..", "web", "dist"),
    join(here, "..", "..", "..", "web", "dist"),
    join(here, "web"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return null;
}

async function serveStatic(staticDir: string, pathname: string): Promise<Response | null> {
  const safe = pathname.replace(/\.\./g, "").replace(/\/+/g, "/");
  const candidate = join(staticDir, safe === "/" ? "/index.html" : safe);
  if (existsSync(candidate)) {
    const file = Bun.file(candidate);
    return new Response(file);
  }
  // SPA fallback: serve index.html for non-asset paths.
  if (!safe.includes(".")) {
    return new Response(Bun.file(join(staticDir, "index.html")));
  }
  return null;
}

export async function startServer(
  opts: ServerOptions,
): Promise<{ url: string; server: ReturnType<typeof Bun.serve> }> {
  const staticDir = getStaticDir();
  const viteDevUrl = process.env["VITE_DEV_SERVER_URL"] ?? null;

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      // DNS-rebinding defense: reject any request whose Host header isn't a
      // loopback name. An attacker who points evil.com at 127.0.0.1 still
      // sends Host: evil.com to the browser, which we reject here.
      if (!isLoopbackHost(req.headers.get("host"))) {
        return new Response("forbidden: non-loopback host", {
          status: 403,
          headers: { "content-type": "text/plain" },
        });
      }

      // CORS for vite dev server (different port). Non-loopback origins get
      // an empty header set from corsHeaders() → browser blocks both
      // preflight and the response, preventing CSRF-style side effects on
      // mutating endpoints (e.g. POST /api/run/$playName triggering spend).
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(req),
        });
      }

      if (url.pathname.startsWith("/api/")) {
        const match = findRoute(req);
        if (!match) {
          return jsonResponse({ error: "not found", path: url.pathname }, 404, req);
        }
        try {
          const res = await match.handler(req, match.params);
          // Inject CORS headers if not already set
          for (const [k, v] of Object.entries(corsHeaders(req))) {
            if (!res.headers.has(k)) res.headers.set(k, v);
          }
          return res;
        } catch (err) {
          return jsonResponse({ error: (err as Error).message ?? "internal error" }, 500, req);
        }
      }

      // Static / SPA serving
      if (staticDir) {
        const r = await serveStatic(staticDir, url.pathname);
        if (r) return r;
      }

      // Dev: tell the user where the UI is hosted by Vite.
      if (viteDevUrl) {
        return new Response(
          `<!doctype html><title>oneshot-gtm dev</title>` +
            `<p>API is running at <code>${url.origin}/api</code>.</p>` +
            `<p>Vite dev server should be at <a href="${viteDevUrl}">${viteDevUrl}</a>.</p>`,
          { headers: { "content-type": "text/html" } },
        );
      }

      return new Response(
        "oneshot-gtm server running. Build the web app to see the dashboard, or set VITE_DEV_SERVER_URL.",
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    },
  });

  return { url: `http://127.0.0.1:${server.port}`, server };
}

function isLoopbackOrigin(origin: string): boolean {
  // Empty origin = same-origin request (curl, server-side fetch); allow.
  if (origin === "") return true;
  return (
    origin.startsWith("http://127.0.0.1") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://[::1]")
  );
}

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function corsHeaders(req: Request): Record<string, string> {
  // Loopback-only. Non-loopback origins get NO Access-Control-* headers,
  // which makes the browser refuse both the preflight and any cross-origin
  // response read.
  const origin = req.headers.get("origin") ?? "";
  if (!isLoopbackOrigin(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin || "http://127.0.0.1",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
}

export function jsonResponse(body: unknown, status = 200, req?: Request): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (req) Object.assign(headers, corsHeaders(req));
  return new Response(JSON.stringify(body), { status, headers });
}
