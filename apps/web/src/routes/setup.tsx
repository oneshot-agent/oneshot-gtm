import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import type { TriggerView } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Skeleton } from "../components/primitives/Skeleton.tsx";
import { CredentialsSection } from "../components/setup/CredentialsSection.tsx";
import { EmailTransportSection } from "../components/setup/EmailTransportSection.tsx";
import { FounderSection } from "../components/setup/FounderSection.tsx";
import { IcpSection } from "../components/setup/IcpSection.tsx";
import { LlmSection } from "../components/setup/LlmSection.tsx";
import { ProductBriefSection } from "../components/setup/ProductBriefSection.tsx";
import { ReviewQueueSection } from "../components/setup/ReviewQueueSection.tsx";
import { SectionNav, jumpToSection } from "../components/setup/SectionNav.tsx";
import { SocialProofSection } from "../components/setup/SocialProofSection.tsx";
import { TelemetrySection } from "../components/setup/TelemetrySection.tsx";
import { WalletSection } from "../components/setup/WalletSection.tsx";
import { storedXEngine, XSection } from "../components/setup/XSection.tsx";
import { SECTIONS, type SectionId } from "../components/setup/constants.ts";
import type { DirtyReporter, SetupStatus } from "../components/setup/types.ts";

interface SetupSearch {
  /**
   * A pack's proposed ICP, deep-linked from /queue's "Accept in Setup" action
   * (see PackRow in queue.tsx). Prefills the ICP field only — apply-pack never
   * writes icpOneLiner to config.json itself; the founder still has to Save.
   */
  proposedIcp?: string;
  /** Which pack proposed it, for the banner copy. */
  packLabel?: string;
}

export const Route = createFileRoute("/setup")({
  staticData: { title: "Setup" },
  validateSearch: (search: Record<string, unknown>): SetupSearch => ({
    proposedIcp: typeof search["proposedIcp"] === "string" ? search["proposedIcp"] : undefined,
    packLabel: typeof search["packLabel"] === "string" ? search["packLabel"] : undefined,
  }),
  component: SetupPage,
});

const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));

/**
 * /setup (issue #451): eleven sections, each with its own draft, validation
 * and Save. The page owns only what spans sections — the query, the dirty
 * registry behind the rail dots and the leave guard, the Smartlead-key epoch,
 * and the two URL round-trips (Gmail OAuth outcome, #section deep links).
 */
function SetupPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const triggers = useQuery({ queryKey: ["triggers"], queryFn: api.triggers });
  const { proposedIcp, packLabel } = Route.useSearch();

  // Which sections have unsaved edits — reported by each section, read by
  // the rail and the leave guard. A ref mirrors it for the blocker callbacks.
  const [dirty, setDirty] = useState<Partial<Record<SectionId, boolean>>>({});
  const anyDirty = Object.values(dirty).some(Boolean);
  const anyDirtyRef = useRef(false);
  anyDirtyRef.current = anyDirty;
  const onDirtyChange = useCallback<DirtyReporter>((id, flag) => {
    setDirty((d) => (Boolean(d[id]) === flag ? d : { ...d, [id]: flag }));
  }, []);
  useBlocker({
    shouldBlockFn: () =>
      anyDirtyRef.current && !window.confirm("Unsaved changes on this page — leave anyway?"),
    enableBeforeUnload: () => anyDirtyRef.current,
  });

  // Credentials saved a new Smartlead key → the email section's loaded
  // account list (and staged picks) belong to the old workspace.
  const [smartleadKeyEpoch, bumpSmartleadKey] = useReducer((n: number) => n + 1, 0);

  // Round-trip result from the browser OAuth flow (/api/gmail/auth/callback
  // redirects back here with ?gmailAuth=ok:<address> | error:<reason>).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("gmailAuth");
    if (!outcome) return;
    if (outcome.startsWith("ok:")) {
      toast.success(`Gmail connected · ${outcome.slice(3)} joined the rotation pool`);
    } else {
      toast.error(`Gmail auth failed · ${outcome.replace(/^error:/, "")}`);
    }
    params.delete("gmailAuth");
    const qs = params.toString();
    // Preserve history.state — TanStack Router keeps its index/key there.
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
    void qc.invalidateQueries({ queryKey: ["setup"] });
    void qc.invalidateQueries({ queryKey: ["doctor"] });
  }, [qc]);

  // #section deep link. The router's own hash scroll runs when the route
  // resolves — before ["setup"] has data, so the target doesn't exist yet —
  // and the root layout then resets <main> to the top. Jump once the
  // sections have rendered.
  const hashJumped = useRef(false);
  const loaded = Boolean(status.data);
  useEffect(() => {
    if (!loaded || hashJumped.current) return;
    hashJumped.current = true;
    const id = window.location.hash.slice(1);
    if (!SECTION_IDS.has(id)) return;
    const raf = requestAnimationFrame(() => jumpToSection(id as SectionId, "auto"));
    return () => cancelAnimationFrame(raf);
  }, [loaded]);

  // Active rail item: the first section (in page order) currently on screen.
  const [visible, setVisible] = useState<Set<SectionId>>(() => new Set());
  useEffect(() => {
    if (!loaded) return;
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el != null,
    );
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const id = e.target.id as SectionId;
            if (e.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      },
      { rootMargin: "-10% 0px -60% 0px" },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [loaded]);
  const active = SECTIONS.find((s) => visible.has(s.id))?.id ?? null;

  // Workspace-aware: the server already reports the real secrets path.
  const homeDir = status.data?.secretsPath?.replace(/\/\.env$/, "") ?? "~/.oneshot-gtm";
  const xTrigger = triggers.data?.triggers.find((t) => t.name === "x-reposters");

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      <section className="flex items-end justify-between gap-4 border-b border-ink-rule px-6 pb-5 pt-6">
        <div>
          <div className="ln-eyebrow">The Ledger · Setup</div>
          <h1
            className="mt-1 text-ink-cream"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 44,
              fontWeight: 600,
              letterSpacing: "-0.025em",
              lineHeight: 0.98,
            }}
          >
            Profile, provider, wallet.
          </h1>
        </div>
        <span className="text-[11px] text-ink-faint ln-mono">
          saved to <span className="text-ink-muted">{homeDir}/config.json</span> ·{" "}
          <span className="text-ink-muted">.env</span> · chmod 600 · each section saves on its own
        </span>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr]">
        <div className="lg:sticky lg:top-0 lg:self-start">
          <SectionNav dirty={dirty} active={active} />
        </div>
        <div className="min-w-0">
          {status.data ? (
            <Sections
              status={status.data}
              xTrigger={xTrigger}
              homeDir={homeDir}
              proposedIcp={proposedIcp}
              packLabel={packLabel}
              smartleadKeyEpoch={smartleadKeyEpoch}
              onSmartleadKeySaved={bumpSmartleadKey}
              onDirtyChange={onDirtyChange}
            />
          ) : status.error ? (
            <div className="px-6 py-8 font-mono text-[12px] text-[color:var(--ink-blocked-2)]">
              couldn't load setup · {status.error.message}
            </div>
          ) : (
            <div className="flex flex-col gap-8 px-6 py-8">
              {SECTIONS.slice(0, 4).map((s) => (
                <Skeleton key={s.id} lines={3} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Sections({
  status,
  xTrigger,
  homeDir,
  proposedIcp,
  packLabel,
  smartleadKeyEpoch,
  onSmartleadKeySaved,
  onDirtyChange,
}: {
  status: SetupStatus;
  xTrigger: TriggerView | undefined;
  homeDir: string;
  proposedIcp?: string;
  packLabel?: string;
  smartleadKeyEpoch: number;
  onSmartleadKeySaved: () => void;
  onDirtyChange: DirtyReporter;
}) {
  const { cfg, sources } = status;
  const common = { cfg, sources, onDirtyChange };
  const isLegacyPool = status.identities?.[0]?.legacy ?? true;
  return (
    <>
      <FounderSection {...common} />
      <IcpSection {...common} proposedIcp={proposedIcp} packLabel={packLabel} />
      <SocialProofSection {...common} />
      <ProductBriefSection {...common} />
      <LlmSection {...common} />
      <WalletSection {...common} homeDir={homeDir} />
      <XSection sources={sources} xTrigger={xTrigger} onDirtyChange={onDirtyChange} />
      <EmailTransportSection
        status={status}
        smartleadKeyEpoch={smartleadKeyEpoch}
        onDirtyChange={onDirtyChange}
      />
      <ReviewQueueSection {...common} />
      <TelemetrySection {...common} />
      <CredentialsSection
        {...common}
        homeDir={homeDir}
        isLegacyPool={isLegacyPool}
        xEngine={storedXEngine(xTrigger)}
        onSmartleadKeySaved={onSmartleadKeySaved}
      />
    </>
  );
}
