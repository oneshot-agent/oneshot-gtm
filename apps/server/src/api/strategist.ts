import { loadConfig, logEvent, startRun } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import { effectiveIntervalMs, TRIGGERS } from "@oneshot-gtm/find";
import type { StrategistFrame, StrategistRequest } from "@oneshot-gtm/shared-types";
import { getLedger } from "@oneshot-gtm/core";
import { jsonResponse } from "../server.ts";

/**
 * SSE chat endpoint for the trigger strategist.
 *
 * Request: { messages: Array<{ role: "user"|"assistant", content: string }> }
 *
 * The server composes the system prompt by interpolating the founder's
 * ICP/product + a one-paragraph brief per available trigger, then calls
 * `complete()` once per turn. The assistant uses ACTION markers
 * (<!--ACTION:enable:show-hn--> etc) to propose changes; the client renders
 * them as confirmation chips and posts back through the existing trigger
 * REST endpoints when the founder clicks.
 *
 * No native tool calling — keeps the contract simple, mirrors the soul-hunt-web
 * strategist pattern, and works with every provider that supports plain
 * chat completion.
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

  const systemPrompt = composeSystemPrompt({
    productOneLiner: cfg.productOneLiner!,
    icpOneLiner: cfg.icpOneLiner!,
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
          // ran long (agent-builders combos easily hit ~600 chars of JSON +
          // prose). Bumped to 4096 so a multi-combo config never gets clipped
          // mid-marker.
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

function composeSystemPrompt(args: { productOneLiner: string; icpOneLiner: string }): string {
  const template = loadPrompt("strategist-trigger");
  const triggerCatalog = buildTriggerCatalog();
  return template
    .replace("{{productOneLiner}}", args.productOneLiner)
    .replace("{{icpOneLiner}}", args.icpOneLiner)
    .replace("{{triggerCatalog}}", triggerCatalog);
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
