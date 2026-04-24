import type { ChatModelAdapter, ChatModelRunOptions } from "@assistant-ui/react";
import type { StrategistFrame, StrategistMessage } from "@oneshot-gtm/shared-types";

const ENDPOINT = "/api/strategist/stream";

/**
 * Adapter that bridges assistant-ui's ChatModelAdapter contract to our
 * SSE strategist endpoint. Streams text deltas as they arrive; surfaces
 * server errors as inline assistant text so the chat doesn't go silent.
 *
 * Query invalidation lives in the action-chip onClick (StrategistChat) —
 * the adapter has no notion of which trigger was applied, so wiring a
 * callback here was dead surface area. Removed.
 */
export function createStrategistAdapter(): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }: ChatModelRunOptions) {
      const wireMessages: StrategistMessage[] = [];
      for (const m of messages) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        const text = (m.content ?? [])
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
        if (text.length === 0) continue;
        wireMessages.push({ role: m.role, content: text });
      }

      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: wireMessages }),
          signal: abortSignal,
        });
      } catch (err) {
        yield {
          content: [
            { type: "text", text: `Error contacting strategist: ${(err as Error).message}` },
          ],
        };
        return;
      }

      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.json()).error ?? "";
        } catch {
          detail = await response.text().catch(() => "");
        }
        yield {
          content: [
            {
              type: "text",
              text: `Error: ${detail || `${response.status} ${response.statusText}`}`,
            },
          ],
        };
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        yield { content: [{ type: "text", text: "Error: no response stream" }] };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      // Generator output is a snapshot of the assistant message so far —
      // we re-yield the full text on each delta so assistant-ui re-renders
      // it cleanly. Same shape soul-hunt-web uses.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const block of events) {
          const frame = parseFrame(block);
          if (!frame) continue;
          if (frame.kind === "delta") {
            accumulated += frame.text;
            yield { content: [{ type: "text", text: accumulated }] };
          } else if (frame.kind === "error") {
            accumulated += `\n\nError: ${frame.message}`;
            yield { content: [{ type: "text", text: accumulated }] };
          } else if (frame.kind === "done") {
            return;
          }
          // 'thinking' frame is informational; the UI shows a spinner via
          // assistant-ui's own pending state — no need to render extra text.
        }
      }
    },
  };
}

function parseFrame(block: string): StrategistFrame | null {
  let kind = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) kind = line.slice(7).trim();
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  if (!kind || !data) return null;
  try {
    return JSON.parse(data) as StrategistFrame;
  } catch {
    return null;
  }
}
