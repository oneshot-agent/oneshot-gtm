import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { api } from "../../api/client.ts";
import { Button } from "../primitives/Button.tsx";
import { useLocalStorage } from "../../lib/useLocalStorage.ts";

interface Step {
  id: "icp" | "find" | "drain";
  title: string;
  lede: string;
  cta: string;
  href: "/setup" | "/queue";
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
    id: "find",
    title: "Run your first finder",
    lede: "Pick a trigger (Show HN is cheapest) and click Run now. Results land in the queue for your review before anything sends.",
    cta: "Open the queue",
    href: "/queue",
  },
  {
    id: "drain",
    title: "Approve a target and drain",
    lede: "Approve a queued row, then click drain to send. The cadence engine takes over from there.",
    cta: "Open the queue",
    href: "/queue",
  },
];

const SKIP_KEY = "oneshot-gtm:onboarding-skipped";

export function NextStep() {
  const [skipped, setSkipped] = useLocalStorage(SKIP_KEY);

  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const triggers = useQuery({ queryKey: ["triggers"], queryFn: api.triggers });
  // Reuses the cache key from index.tsx's home queue query.
  const queue = useQuery({
    queryKey: ["queue", "recent", "home"],
    queryFn: () => api.queue({ limit: 16 }),
  });

  if (skipped) return null;
  if (setup.isLoading || triggers.isLoading || queue.isLoading) return null;

  const icpDone = (setup.data?.cfg.icpOneLiner ?? "").trim().length > 0;
  const findDone =
    (triggers.data?.triggers ?? []).some((t) => t.lastPolledAt !== null) ||
    (queue.data?.counts.pending ?? 0) + (queue.data?.counts.sent ?? 0) > 0;
  const drainDone = (queue.data?.counts.sent ?? 0) > 0;

  const done: Record<Step["id"], boolean> = { icp: icpDone, find: findDone, drain: drainDone };
  const ix = STEPS.findIndex((s) => !done[s.id]);
  if (ix === -1) return null;

  const step = STEPS[ix]!;

  return (
    <section className="border-b border-ink-rule px-6 pb-5 pt-5">
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1">
          <div className="ln-eyebrow">Next step · {ix + 1} of {STEPS.length}</div>
          <h2
            className="mt-1 text-ink-cream"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 28,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            {step.title}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-cream-2">{step.lede}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Link to={step.href}>
            <Button size="sm" variant="primary">
              {step.cta} <ArrowRight size={12} />
            </Button>
          </Link>
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
