import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
} from "@assistant-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { Button } from "../primitives/Button.tsx";
import { createStrategistAdapter } from "../../lib/strategist-runtime.ts";
import {
  parseStrategistAction,
  stripActionMarkers,
  type ParsedStrategistAction,
} from "../../lib/strategistAction.ts";

const SUGGESTIONS = [
  "What should I enable for my ICP?",
  "Configure agent-builders for me",
  "Tune everything for my product",
];

/**
 * Global strategist dock: a floating launcher pinned to the lower-right and a
 * slide-in side drawer that opens on click. Mirrors the soul-hunt-web pattern
 * (apps/soul-hunt-web/src/components/game/strategist-chat.tsx).
 *
 * Always mounted so chat history survives across page navigations + drawer
 * close/reopen within a session.
 */
export function StrategistDock() {
  const [open, setOpen] = useState(false);
  const adapter = useMemo(() => createStrategistAdapter(), []);
  const runtime = useLocalRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* Launcher — bottom-right floating button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close strategist" : "Open strategist"}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-ink-rule bg-ink-surface px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-ink-cream shadow-lg transition-colors hover:border-ink-rule-2 hover:bg-ink-surface-2"
      >
        <Sparkles size={14} />
        Strategist
      </button>

      {/* Backdrop — clickable to close, dims the page when open */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink-bg/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Drawer — always mounted (preserves chat state when closed) */}
      <aside
        className={
          "fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l border-ink-rule bg-ink-bg-deep shadow-2xl transition-transform duration-200 sm:w-[440px] " +
          (open ? "translate-x-0" : "translate-x-full")
        }
        aria-hidden={!open}
      >
        <DrawerHeader onClose={() => setOpen(false)} />
        <ChatBody />
      </aside>
    </AssistantRuntimeProvider>
  );
}

function DrawerHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-ink-rule px-5 py-3">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-ink-cream-2" />
        <div className="ln-eyebrow">Strategist</div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close strategist"
        className="cursor-pointer rounded-full p-1 text-ink-faint transition-colors hover:bg-ink-surface hover:text-ink-cream"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function ChatBody() {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Empty>
        <div className="border-b border-ink-rule/60 px-5 py-4">
          <p className="text-sm text-ink-cream-2">
            Tell me what to set up. I'll propose configs anchored in your ICP + product and ask
            before applying anything. Try a chip below or ask anything.
          </p>
        </div>
      </ThreadPrimitive.Empty>

      <ThreadPrimitive.Viewport className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <ThreadPrimitive.Messages
          components={{ UserMessage, AssistantMessage: AssistantMessageWithActions }}
        />
      </ThreadPrimitive.Viewport>

      {/* Suggestion chips */}
      <div className="flex flex-wrap gap-2 border-t border-ink-rule/60 px-5 py-2">
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
      <div className="border-t border-ink-rule px-5 py-3">
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

function RenderedAssistantText({ text }: { text: string }) {
  const action = parseStrategistAction(text);
  const cleanText = stripActionMarkers(text);
  return (
    <div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-cream-2">{cleanText}</p>
      {action && <ActionChip action={action} />}
    </div>
  );
}

function ActionChip({ action }: { action: ParsedStrategistAction }) {
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
