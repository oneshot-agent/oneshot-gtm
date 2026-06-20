import { loadConfig, logEvent, startRun, webSearch } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import { effectiveIntervalMs, TRIGGERS } from "@oneshot-gtm/find";
import type { StrategistFrame, StrategistRequest } from "@oneshot-gtm/shared-types";
import { getLedger } from "@oneshot-gtm/core";
import { jsonResponse } from "../server.ts";

/**
 * SSE chat endpoint for the trigger strategist.
 * Request: { messages: Array<{ role: "user"|"assistant", content: string }> }.
 *
 * Composes a system prompt from the founder's ICP/product + a brief per trigger,
 * then calls `complete()` once per turn. The assistant proposes changes via
 * ACTION markers (<!--ACTION:enable:show-hn-->) that the client renders as
 * confirmation chips and posts back through the trigger REST endpoints. No native
 * tool calling — keeps the contract simple and works with any chat provider.
 */
/**
 * Pure body-shape check, extracted so HTTP tests can exercise the failure
 * paths without mocking fetch / Bun.serve. Returns either the parsed
 * messages or a status+error pair the caller can mirror back as JSON.
 */
export function validateStrategistBody(
  raw: unknown,
):
  | { kind: "ok"; messages: StrategistRequest["messages"] }
  | { kind: "error"; status: number; error: string } {
  if (!raw || typeof raw !== "object") {
    return { kind: "error", status: 400, error: "messages must be a non-empty array" };
  }
  const body = raw as Partial<StrategistRequest>;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { kind: "error", status: 400, error: "messages must be a non-empty array" };
  }
  for (const m of body.messages) {
    if (!m || typeof m !== "object") {
      return { kind: "error", status: 400, error: "each message must be an object" };
    }
    if (m.role !== "user" && m.role !== "assistant") {
      return {
        kind: "error",
        status: 400,
        error: `each message.role must be 'user' or 'assistant' (got ${String(m.role)})`,
      };
    }
    if (typeof m.content !== "string") {
      return { kind: "error", status: 400, error: "each message.content must be a string" };
    }
  }
  return { kind: "ok", messages: body.messages };
}

/**
 * Pure cfg readiness check — strategist needs ICP + product to anchor
 * proposals. Same shape as validateStrategistBody so the route handler
 * can mirror either failure verbatim.
 */
export function validateCfgForStrategist(cfg: {
  icpOneLiner?: string | null;
  productOneLiner?: string | null;
}): { kind: "ok" } | { kind: "error"; status: number; error: string } {
  if (!cfg.icpOneLiner || cfg.icpOneLiner.trim().length === 0) {
    return {
      kind: "error",
      status: 400,
      error: "set ICP one-liner in /setup before opening the strategist",
    };
  }
  if (!cfg.productOneLiner || cfg.productOneLiner.trim().length === 0) {
    return {
      kind: "error",
      status: 400,
      error: "set product one-liner in /setup before opening the strategist",
    };
  }
  return { kind: "ok" };
}

export async function strategistRoute(req: Request): Promise<Response> {
  startRun();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }
  const bodyCheck = validateStrategistBody(raw);
  if (bodyCheck.kind === "error") {
    return jsonResponse({ error: bodyCheck.error }, bodyCheck.status, req);
  }
  const messages = bodyCheck.messages;

  const cfg = loadConfig();
  const cfgCheck = validateCfgForStrategist(cfg);
  if (cfgCheck.kind === "error") {
    return jsonResponse({ error: cfgCheck.error }, cfgCheck.status, req);
  }

  // Pre-search the web for accelerator data when the founder's latest message
  // is about cohort selection. Strategist's training-data knowledge of which
  // accelerators exist + are accepting applications is stale by months; live
  // search gives it fresh context to ground its proposal in. Empty string when
  // not applicable — composeSystemPrompt then renders no extra section.
  const latestUserMessage = messages.toReversed().find((m) => m.role === "user")?.content ?? "";
  const webContext = await maybeAcceleratorWebContext(latestUserMessage, cfg.icpOneLiner!);

  const systemPrompt = composeSystemPrompt({
    productOneLiner: cfg.productOneLiner!,
    icpOneLiner: cfg.icpOneLiner!,
    webContext,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: StrategistFrame): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Client disconnected mid-stream — controller already closed by
          // the runtime. Mark and stop trying to write.
          closed = true;
        }
      };

      const startedAt = Date.now();
      logEvent("strategist.turn.start", { message_count: messages.length });
      try {
        send({ kind: "thinking" });
        const llm = await complete({
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map((m) => ({ role: m.role, content: m.content }) as const),
          ],
          temperature: 0.4,
          // 800 tokens truncated apply-config markers when the proposed JSON
          // ran long (a fully-populated github-topics config with topics +
          // vendors + yourEdge easily hits ~600 chars of JSON + prose). Bumped
          // to 4096 so a multi-field config never gets clipped mid-marker.
          maxTokens: 4096,
        });
        // Fake-stream the assistant content in chunks so the UI gets
        // progressive text instead of a single late drop. Real token streaming
        // is a future hop on intel.complete; this is good enough for chat
        // turns that complete in ~5-10s.
        //
        // Split on Unicode code points (Array.from), not UTF-16 code units —
        // a midstream split through a surrogate pair would yield mojibake on
        // the client. Chunk size is in code-points, not bytes.
        const codePoints = Array.from(llm.content);
        const CHUNK_CODE_POINTS = 60;
        for (let i = 0; i < codePoints.length; i += CHUNK_CODE_POINTS) {
          if (closed) break;
          send({ kind: "delta", text: codePoints.slice(i, i + CHUNK_CODE_POINTS).join("") });
        }
        send({ kind: "done" });
        logEvent("strategist.turn.done", {
          duration_ms: Date.now() - startedAt,
          response_chars: llm.content.length,
        });
      } catch (err) {
        const message = (err as Error).message ?? "strategist failed";
        logEvent(
          "strategist.turn.error",
          {
            duration_ms: Date.now() - startedAt,
            message_120: message.slice(0, 120),
          },
          "error",
        );
        send({ kind: "error", message });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by client disconnect — ignore
        }
      }
    },
  });

  // Mirror the loopback CORS handling used by /api/run/:playName.
  const origin = req.headers.get("origin") ?? "";
  const isLoopback =
    origin === "" ||
    origin.startsWith("http://127.0.0.1") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://[::1]");
  const sseHeaders: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  };
  if (isLoopback) {
    sseHeaders["Access-Control-Allow-Origin"] = origin || "http://127.0.0.1";
    sseHeaders["Vary"] = "Origin";
  }

  return new Response(stream, { status: 200, headers: sseHeaders });
}

function composeSystemPrompt(args: {
  productOneLiner: string;
  icpOneLiner: string;
  webContext: string;
}): string {
  const template = loadPrompt("strategist-trigger");
  const triggerCatalog = buildTriggerCatalog();
  return template
    .replace("{{productOneLiner}}", args.productOneLiner)
    .replace("{{icpOneLiner}}", args.icpOneLiner)
    .replace("{{triggerCatalog}}", triggerCatalog)
    .replace("{{webContext}}", args.webContext);
}

/**
 * Trigger phrases that imply the founder wants accelerator-batch help. Loose
 * enough to catch "pick an accelerator", "yc batch", "any incubators?", etc.
 * Tight enough that "what should I enable for my ICP?" doesn't fire.
 */
const ACCELERATOR_KEYWORDS =
  /\b(accelerator|cohort|batch|incubator|y[ -]?combinator|techstars|antler|ai[ -]?grant|spc|south\s*park|neo|500\s*global)\b/i;

/**
 * If the founder's latest message asks about accelerator-batch, run a web
 * search for accelerators that fit their ICP and format the results as a
 * markdown block to inject into the system prompt. Empty string otherwise
 * (the placeholder collapses to nothing).
 *
 * Cost: ~$0.01 per accelerator-related strategist message. Latency: ~5-15s.
 * Wrapped in try/catch so a search hiccup doesn't block the strategist's
 * normal response.
 */
async function maybeAcceleratorWebContext(
  latestUserMessage: string,
  icpOneLiner: string,
): Promise<string> {
  if (!ACCELERATOR_KEYWORDS.test(latestUserMessage)) return "";
  try {
    const query = `${icpOneLiner} startup accelerator OR cohort OR grant 2026 batch`;
    const search = await webSearch({ query, maxResults: 8 }, { playName: "strategist" });
    const results = search.result.results ?? [];
    if (results.length === 0) {
      logEvent("strategist.web_search.accelerators", { query_chars: query.length, count: 0 });
      return "";
    }
    const lines = results.slice(0, 8).map((r) => {
      const title = (r.title ?? "").slice(0, 160);
      const url = (r.url ?? "").slice(0, 200);
      const desc = (r.description ?? "").slice(0, 240);
      return `- **${title}** — ${url}\n  ${desc}`;
    });
    logEvent("strategist.web_search.accelerators", {
      query_chars: query.length,
      count: results.length,
    });
    return [
      "## Recent accelerator landscape (web-searched for ICP fit)",
      "",
      "When proposing `accelerator-batch.cohort`, ground your pick in these",
      "results rather than your training-data memory of which accelerators exist.",
      "Reason from the founder's ICP to which accelerator's portfolio overlaps best.",
      "",
      ...lines,
    ].join("\n");
  } catch (err) {
    logEvent(
      "strategist.web_search.failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return "";
  }
}

function buildTriggerCatalog(): string {
  const ledger = getLedger();
  const stored = new Map(ledger.listTriggers().map((r) => [r.name, r]));
  const lines: string[] = [];
  for (const spec of TRIGGERS) {
    const row = stored.get(spec.name);
    const defaultEnabled = spec.enabledByDefault !== false;
    const enabled = row ? Boolean(row.enabled) : defaultEnabled;
    const config = row?.config_json ? row.config_json : JSON.stringify(spec.defaultConfig);
    const intervalMs = effectiveIntervalMs(spec, safeParse(config));
    lines.push(
      `### ${spec.name}` +
        `\n- enabled: ${enabled}` +
        `\n- interval: ${humanInterval(intervalMs)}` +
        `\n- current config: ${config}` +
        `\n- brief: ${spec.configBrief ?? "(no brief — defaults are sane)"}`,
    );
  }
  return lines.join("\n\n");
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function humanInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 24 * 3600_000) return `${(ms / 3600_000).toFixed(1)}h`;
  return `${(ms / (24 * 3600_000)).toFixed(1)}d`;
}
