import { useEffect, useState, type ReactNode } from "react";
import { DEMO_MISS_EVENT } from "../../api/demo.ts";
import { cn } from "../../lib/cn.ts";

/**
 * The chrome that only the vendored demo build wears.
 *
 * Two jobs. The ribbon says what a visitor is looking at, because a dashboard
 * full of plausible names and dollar figures has to declare that the names are
 * invented before it shows them. And the gate handles a narrow window, which
 * this app has no other answer for: the shell is a fixed 224px rail beside a
 * fluid column, and there are 44 responsive prefixes in the whole product.
 *
 * "Show it anyway" opens the real thing on a 1180px stage that scrolls inside
 * itself, and the ribbon then carries the way back. If you add a way in, add
 * the way out.
 */

const SITE = "https://oneshot-gtm.com";
const REPO = "https://github.com/oneshot-agent/oneshot-gtm";

export function DemoFrame({ children }: { children: ReactNode }) {
  const [forced, setForced] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <DemoRibbon forced={forced} onNarrow={() => setForced(false)} />

      {!forced && <NarrowGate onShowAnyway={() => setForced(true)} />}

      {/*
        Below 900px the app is hidden rather than unmounted, so opting in does
        not throw away the query cache and re-read every fixture.

        `max-[900px]` against the gate's `min-[900px]`, not `max-[899px]`:
        tailwind compiles max-* to `not (width >= N)`, so a 899/900 pair leaves
        899px showing both the gate and the app under it.
      */}
      <div className={cn("min-h-0 flex-1", forced ? "overflow-x-auto" : "max-[900px]:hidden")}>
        <div className={cn("h-full", forced && "min-w-[1180px]")}>{children}</div>
      </div>
    </div>
  );
}

function DemoRibbon({ forced, onNarrow }: { forced: boolean; onNarrow: () => void }) {
  const missing = useFixtureMiss();

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-ink-rule bg-ink-surface px-4 py-1.5 text-[11.5px] text-ink-muted">
      <div className="flex items-center gap-2.5">
        <span className="rounded-[var(--radius-xs)] border border-[color:var(--ink-spend)] px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--ink-spend-2)]">
          Demo
        </span>
        {/*
          Both halves are load-bearing. The prospects are invented, and the
          per-call prices are `demo seed`'s own rather than OneShot's, which the
          site says of the screenshots shot against this same ledger and has to
          say here too. Read-only covers the rest: nothing can be sent or spent.
        */}
        {missing ? (
          <span className="text-[color:var(--ink-blocked-2)]">
            Part of this demo did not load, so a page may be showing less than the ledger holds.
            Reloading is worth a try.
          </span>
        ) : (
          <span>
            A seeded ledger, read only. The prospects are invented, and the per-call prices are the
            seed&rsquo;s own, higher than OneShot charges.
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {forced && (
          <button
            type="button"
            onClick={onNarrow}
            className="text-ink-cream-2 underline hover:text-ink-cream min-[900px]:hidden"
          >
            Narrow view
          </button>
        )}
        <a href={REPO} className="text-ink-cream-2 hover:text-ink-cream">
          Repo
        </a>
        <a href={SITE} className="text-ink-cream-2 hover:text-ink-cream">
          oneshot-gtm.com
        </a>
      </div>
    </div>
  );
}

/**
 * True once any fixture has 404'd.
 *
 * The transport can miss before this mounts, hence the initial read of the
 * attribute rather than waiting only on the event.
 */
function useFixtureMiss(): boolean {
  const [missing, setMissing] = useState(
    () => document.documentElement.dataset["demoFixtureMiss"] != null,
  );

  useEffect(() => {
    const onMiss = (): void => setMissing(true);
    window.addEventListener(DEMO_MISS_EVENT, onMiss);
    return () => window.removeEventListener(DEMO_MISS_EVENT, onMiss);
  }, []);

  return missing;
}

function NarrowGate({ onShowAnyway }: { onShowAnyway: () => void }) {
  return (
    <div className="flex flex-1 flex-col justify-center gap-6 px-6 py-10 min-[900px]:hidden">
      <div>
        <div className="ln-eyebrow">The demo</div>
        <h1 className="ln-display mt-3 text-[clamp(1.9rem,9vw,2.6rem)] text-ink-cream">
          This one wants a wider window.
        </h1>
        <p className="ln-note mt-4 max-w-[38ch] text-[15px] leading-relaxed">
          Nine pages, a fixed rail and tables built for a keyboard. On a phone you would spend the
          whole visit scrolling sideways.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onShowAnyway}
          className="w-fit rounded-[var(--radius-sm)] border border-ink-rule-2 px-3.5 py-2 text-[13px] text-ink-cream hover:bg-ink-surface-2"
        >
          Show it anyway
        </button>
        <a
          href={SITE}
          className="w-fit text-[13px] text-ink-cream-2 underline hover:text-ink-cream"
        >
          Back to oneshot-gtm.com
        </a>
      </div>

      <div className="border-t border-ink-rule pt-5">
        <p className="ln-note text-[13px]">Or run the real one, on your own ledger:</p>
        <code className="ln-mono mt-2 block overflow-x-auto text-[13px] text-ink-cream">
          bunx oneshot-gtm-server
        </code>
      </div>
    </div>
  );
}
