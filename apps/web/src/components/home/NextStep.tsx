import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Explain } from "../primitives/Explain.tsx";
import { api } from "../../api/client.ts";
import { Button } from "../primitives/Button.tsx";
import { useLocalStorage } from "../../lib/useLocalStorage.ts";
import { openStrategist } from "../../lib/openStrategist.ts";

interface Step {
  id: "icp" | "strategy" | "send";
  title: string;
  lede: string;
  cta: string;
  href?: "/setup" | "/queue";
  opensStrategist?: boolean;
}

const STEPS: Step[] = [
  {
    id: "icp",
    title: "Set your ICP",
    lede: "The find layer's classifier drops candidates that don't match. Without one, every result passes through and you'll review more noise than signal.",
    cta: "Open ICP setup",
    href: "/setup",
  },
  {
    id: "strategy",
    title: "Plan your first motion",
    lede: "Your strategist knows your product and ICP. It will recommend a signal, propose the exact config, and ask before applying it.",
    cta: "Open strategist",
    opensStrategist: true,
  },
  {
    id: "send",
    title: "Review and send",
    lede: "The strategist has handed candidates to your queue. Review the evidence and draft, approve one, then send it.",
    cta: "Review the queue",
    href: "/queue",
  },
];

const SKIP_KEY = "oneshot-gtm:onboarding-skipped";

export function NextStep() {
  const [skipped, setSkipped] = useLocalStorage(SKIP_KEY);

  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const triggers = useQuery({ queryKey: ["triggers"], queryFn: api.triggers });
  const home = useQuery({ queryKey: ["home"], queryFn: api.home });
  // Reuses the cache key from index.tsx's home queue query.
  const queue = useQuery({
    queryKey: ["queue", "recent", "home"],
    queryFn: () => api.queue({ limit: 16 }),
  });

  if (skipped) return null;
  if (setup.isLoading || triggers.isLoading || queue.isLoading || home.isLoading) return null;

  const icpDone = (setup.data?.cfg.icpOneLiner ?? "").trim().length > 0;
  const strategyDone =
    home.data?.hasFirstSend === true ||
    (triggers.data?.triggers ?? []).some((t) => t.lastPolledAt !== null) ||
    (queue.data?.counts.pending ?? 0) + (queue.data?.counts.approved ?? 0) > 0;
  const sendDone = home.data?.hasFirstSend === true;

  const done: Record<Step["id"], boolean> = {
    icp: icpDone,
    strategy: strategyDone,
    send: sendDone,
  };
  const ix = STEPS.findIndex((s) => !done[s.id]);
  if (ix === -1) return null;

  const step = STEPS[ix]!;

  return (
    <section className="border-b border-ink-rule bg-ink-bg-deep px-6 py-6">
      <div className="flex items-start justify-between gap-6 rounded-[var(--radius-lg)] border border-ink-rule bg-ink-surface px-6 py-5 shadow-[var(--shadow-inset)]">
        <div className="flex-1">
          <div className="ln-eyebrow">
            Next step · {ix + 1} of {STEPS.length}
          </div>
          <h2
            className="mt-1 text-ink-cream"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            {step.title}
            {step.id !== "strategy" && (
              <Explain concept={step.id === "send" ? "drain" : "icpGate"} />
            )}
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-cream-2">{step.lede}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {step.opensStrategist ? (
            <Button size="sm" variant="primary" onClick={openStrategist}>
              {step.cta} <ArrowRight size={12} />
            </Button>
          ) : (
            <Link to={step.href!}>
              <Button size="sm" variant="primary">
                {step.cta} <ArrowRight size={12} />
              </Button>
            </Link>
          )}
          <button
            type="button"
            onClick={() => setSkipped(true)}
            className="font-mono text-[11px] text-ink-faint transition-colors hover:text-ink-muted"
          >
            Skip
          </button>
        </div>
      </div>
    </section>
  );
}
