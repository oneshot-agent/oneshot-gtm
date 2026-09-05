import { useMutation } from "@tanstack/react-query";
import { Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { Field, Input, Textarea } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

export function IcpSection({
  cfg,
  proposedIcp,
  packLabel,
  onDirtyChange,
}: SectionProps & {
  /** A pack's proposed ICP, deep-linked from /queue's "Accept in Setup". */
  proposedIcp?: string;
  packLabel?: string;
}) {
  const server = useMemo(() => ({ icpOneLiner: cfg.icpOneLiner ?? "" }), [cfg]);
  // The pack proposal seeds the DRAFT, never config.json — the founder still
  // has to Save. Being a draft it also survives every ["setup"] refetch.
  const s = useConfigSection({
    id: "icp",
    server,
    initialDraft: proposedIcp ? { icpOneLiner: proposedIcp } : undefined,
    toRequest: (sent) => sent,
    onDirtyChange,
  });

  // Clear proposedIcp/packLabel from the URL once consumed so a later reload
  // of /setup doesn't re-seed — and re-save — the stale proposal over the
  // founder's own edits. Preserve window.history.state: TanStack Router's
  // __TSR_index/__TSR_key live there, and replacing it with {} desyncs the
  // router's history index (next back/forward becomes a generic GO).
  useEffect(() => {
    if (!proposedIcp) return;
    const params = new URLSearchParams(window.location.search);
    params.delete("proposedIcp");
    params.delete("packLabel");
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
    // Seeded once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const showPackBanner = Boolean(proposedIcp) && s.dirtyKeys.includes("icpOneLiner");

  // The derive prompt reads "a company's marketing site" and writes who THEY
  // sell to — so the founder's own site is the default input, not a peer's.
  // Seeded once; the section mounts only after ["setup"] has data.
  const [icpDomain, setIcpDomain] = useState(() => cfg.productDomain ?? "");
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [deriveSource, setDeriveSource] = useState<{ url: string; cost: number } | null>(null);
  const deriveIcp = useMutation({
    mutationFn: (domain: string) => api.deriveIcp(domain),
    onSuccess: (res) => {
      s.set("icpOneLiner", res.proposedIcp);
      setDeriveSource({ url: res.sourceUrl, cost: res.costUsd });
      setDeriveError(null);
    },
    onError: (err: Error) => {
      setDeriveError(err.message);
      setDeriveSource(null);
    },
  });

  // Elapsed counter so the ~30–60s derive feels alive instead of frozen.
  // Server doesn't stream progress; we cycle a phase label by elapsed time.
  const [deriveElapsed, setDeriveElapsed] = useState(0);
  useEffect(() => {
    if (!deriveIcp.isPending) {
      setDeriveElapsed(0);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => {
      setDeriveElapsed(Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => clearInterval(t);
  }, [deriveIcp.isPending]);
  const derivePhase =
    deriveElapsed < 15
      ? `Reading the page · ${deriveElapsed}s`
      : deriveElapsed < 35
        ? `Still reading — slow pages take a moment · ${deriveElapsed}s`
        : `Asking the LLM to extract an ICP · ${deriveElapsed}s`;

  return (
    <SectionShell
      {...s.shell}
      lede="Who the finders keep. Candidates that don't match this sentence are dropped."
    >
      {showPackBanner && (
        <div className="border-l-2 border-[color:var(--ink-receipt)] bg-[color:var(--ink-receipt)]/10 px-3 py-2 font-mono text-[11.5px] text-ink-cream-2">
          Proposed by {packLabel ?? "an industry pack"} — never written until you Save below. Edit
          or clear it first if it's not right.
        </div>
      )}
      <Field
        label="Derive from a website"
        hint="Your own site is prefilled; a competitor's customers page works too. Reads one page and drafts the sentence for you to edit. ~$0.03."
      >
        <div className="flex gap-2">
          <Input
            value={icpDomain}
            onChange={(e) => setIcpDomain(e.target.value)}
            placeholder="yourcompany.com  ·  competitor.com/customers"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !deriveIcp.isPending && icpDomain.trim().length > 0) {
                e.preventDefault();
                deriveIcp.mutate(icpDomain.trim());
              }
            }}
          />
          <Button
            type="button"
            variant="secondary"
            className="shrink-0 whitespace-nowrap"
            disabled={deriveIcp.isPending || icpDomain.trim().length === 0}
            onClick={() => deriveIcp.mutate(icpDomain.trim())}
            {...readOnly}
          >
            <Wand2 size={12} className={deriveIcp.isPending ? "animate-pulse" : undefined} />
            {deriveIcp.isPending ? `Working · ${deriveElapsed}s` : "Derive ICP"}
          </Button>
        </div>
      </Field>

      {deriveIcp.isPending && (
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-cream-2" />
          {derivePhase}
        </div>
      )}
      {deriveError && (
        <div className="border-l-2 border-[color:var(--ink-blocked)] bg-[color:var(--ink-blocked)]/10 px-3 py-2 font-mono text-[11.5px] text-[color:var(--ink-blocked-2)]">
          {deriveError}
        </div>
      )}
      {deriveSource && !deriveError && (
        <div className="font-mono text-[11px] text-ink-muted">
          drafted from{" "}
          <a
            href={deriveSource.url}
            target="_blank"
            rel="noreferrer"
            className="text-ink-cream-2 underline decoration-ink-faint decoration-1 underline-offset-2 hover:decoration-ink-cream"
          >
            {deriveSource.url}
          </a>{" "}
          · spent ${deriveSource.cost.toFixed(3)} · edit below before saving.
        </div>
      )}

      <Field label="ICP one-liner" hint="Blank = no filtering.">
        <Textarea
          value={s.values.icpOneLiner}
          onChange={(e) => s.set("icpOneLiner", e.target.value)}
          placeholder={
            'e.g. "CFOs at Series-B SaaS" · "Shopify stores doing $1M+/yr" · "indie iOS devs"'
          }
          rows={3}
        />
      </Field>
    </SectionShell>
  );
}
