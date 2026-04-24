import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
} from "@assistant-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { Button } from "../primitives/Button.tsx";
import { createStrategistAdapter } from "../../lib/strategist-runtime.ts";

const SUGGESTIONS = [
  "What should I enable for my ICP?",
  "Configure agent-builders for me",
  "Tune everything for my product",
];

/**
 * Inline chat panel for the trigger strategist. Lives below the Triggers
 * table on /queue. Collapsed by default; toggle via the eyebrow button.
 *
 * Why local-runtime + a custom SSE adapter: the assistant-ui local runtime
 * just calls our adapter's async generator on each turn — no provider lock-in,
 * no extra deps. Same shape soul-hunt-web uses.
 */
export function StrategistChat() {
  const adapter = useMemo(() => createStrategistAdapter(), []);
  const runtime = useLocalRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-[480px] flex-col border-t border-ink-rule bg-ink-bg-deep">
        <ThreadPrimitive.Root className="flex h-full flex-col">
          {/* Welcome strip — only shows before the first message */}
          <ThreadPrimitive.Empty>
            <div className="px-6 py-5">
              <div className="flex items-start gap-3">
                <Sparkles size={14} className="mt-0.5 text-ink-cream-2" />
                <div className="flex-1">
                  <div className="ln-eyebrow">Strategist</div>
                  <p className="mt-1 text-sm text-ink-cream-2">
                    Tell me what to set up. I'll propose configs anchored in your ICP + product and
                    ask before applying anything. Try a chip below or ask anything.
                  </p>
                </div>
              </div>
            </div>
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Viewport className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
            <ThreadPrimitive.Messages
              components={{ UserMessage, AssistantMessage: AssistantMessageWithActions }}
            />
          </ThreadPrimitive.Viewport>

          {/* Suggestion chips — quick-start prompts */}
          <div className="flex flex-wrap gap-2 border-t border-ink-rule/60 px-6 py-2">
            {SUGGESTIONS.map((s) => (
              <ThreadPrimitive.Suggestion
                key={s}
                prompt={s}
                send
                className="cursor-pointer rounded-full border border-ink-rule px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-muted transition-colors hover:border-ink-rule-2 hover:text-ink-cream-2"
              >
                {s}
              </ThreadPrimitive.Suggestion>
            ))}
          </div>

          {/* Composer */}
          <div className="border-t border-ink-rule px-6 py-3">
            <ComposerPrimitive.Root className="flex items-center gap-2">
              <ComposerPrimitive.Input
                placeholder="Ask the strategist..."
                className="flex-1 rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg px-3 py-2 font-mono text-[13px] text-ink-cream outline-none placeholder:text-ink-faint focus:border-ink-rule-2"
              />
              <ComposerPrimitive.Send asChild>
                <Button size="sm" variant="primary">
                  Send
                </Button>
              </ComposerPrimitive.Send>
            </ComposerPrimitive.Root>
          </div>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[80%] rounded-[var(--radius-sm)] border border-ink-rule bg-ink-surface px-3 py-2">
        <MessagePrimitive.Content
          components={{
            Text: ({ text }) => (
              <p className="whitespace-pre-wrap text-sm text-ink-cream">{text}</p>
            ),
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessageWithActions() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="max-w-[90%] rounded-[var(--radius-sm)] border border-ink-rule bg-ink-surface px-3 py-2">
        <MessagePrimitive.Content
          components={{
            Text: ({ text }) => <RenderedAssistantText text={text} />,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

interface ParsedAction {
  kind: "enable" | "disable" | "apply-config";
  trigger: string;
  config?: Record<string, unknown>;
}

// Trigger names contain hyphens (post-funding-auto, agent-builders, show-hn).
// The earlier `[^:>-]+` excluded `-` and silently broke every multi-word
// trigger; only `[^:>]+` is correct. The trigger name capture stops at the
// first `:` (which separates the optional JSON config) or `>` (rare).
const ACTION_RE = /<!--ACTION:(enable|disable|apply-config):([^:>]+?)(?::([\s\S]*?))?-->/;
// Looser match for partial markers mid-stream — used to strip "<!--ACTION:..."
// fragments from displayed text before the closing `-->` arrives, so the
// founder doesn't see the marker scaffolding flicker into view.
const PARTIAL_ACTION_RE = /<!--ACTION:[\s\S]*$/;

function RenderedAssistantText({ text }: { text: string }) {
  const action = parseAction(text);
  // Strip the complete marker first (when present), then strip any trailing
  // half-marker that's still being streamed.
  const cleanText = text.replace(ACTION_RE, "").replace(PARTIAL_ACTION_RE, "").trim();
  return (
    <div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-cream-2">{cleanText}</p>
      {action && <ActionChip action={action} />}
    </div>
  );
}

function parseAction(text: string): ParsedAction | null {
  const m = text.match(ACTION_RE);
  if (!m) return null;
  const kind = m[1] as ParsedAction["kind"];
  const trigger = (m[2] ?? "").trim();
  const rawConfig = m[3] ?? "";
  if (kind === "apply-config") {
    try {
      const config = JSON.parse(rawConfig) as Record<string, unknown>;
      return { kind, trigger, config };
    } catch {
      return null;
    }
  }
  return { kind, trigger };
}

function ActionChip({ action }: { action: ParsedAction }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const apply = useCallback(async () => {
    setPending(true);
    setErr(null);
    try {
      if (action.kind === "enable") {
        await api.setTriggerEnabled(action.trigger, true);
        setDone(`enabled · ${action.trigger}`);
        toast.success(`enabled · ${action.trigger}`);
      } else if (action.kind === "disable") {
        await api.setTriggerEnabled(action.trigger, false);
        setDone(`disabled · ${action.trigger}`);
        toast.success(`disabled · ${action.trigger}`);
      } else if (action.kind === "apply-config" && action.config) {
        await api.setTriggerConfig(action.trigger, action.config);
        setDone(`config saved · ${action.trigger}`);
        toast.success(`config saved · ${action.trigger}`);
      }
      void qc.invalidateQueries({ queryKey: ["triggers"] });
      void qc.invalidateQueries({ queryKey: ["queue"] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPending(false);
    }
  }, [action, qc]);

  if (done) {
    return (
      <div className="mt-2 inline-flex items-center gap-2 rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep px-2.5 py-1.5 font-mono text-[11px] text-ink-receipt-2">
        ✓ {done}
      </div>
    );
  }

  const label =
    action.kind === "enable"
      ? `Enable ${action.trigger}`
      : action.kind === "disable"
        ? `Disable ${action.trigger}`
        : `Apply config to ${action.trigger}`;

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        onClick={apply}
        disabled={pending}
        className="cursor-pointer rounded-[var(--radius-sm)] border border-ink-rule bg-ink-surface px-3 py-1.5 font-mono text-[11px] text-ink-cream transition-colors hover:border-ink-rule-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Applying…" : label}
      </button>
      {err && <span className="font-mono text-[11px] text-ink-blocked-2">err: {err}</span>}
    </div>
  );
}
