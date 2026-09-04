import { useMutation } from "@tanstack/react-query";
import { Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { Field, Textarea } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

export function ProductBriefSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(() => ({ productBrief: cfg.productBrief ?? "" }), [cfg]);
  const s = useConfigSection({
    id: "brief",
    server,
    toRequest: (sent) => sent,
    onDirtyChange,
  });

  // Seeded once from the saved signature domain; the section mounts only
  // after ["setup"] has data, so the initializer sees the real value.
  const [briefSources, setBriefSources] = useState(() =>
    cfg.productDomain ? `https://${cfg.productDomain}` : "",
  );
  const [deriveInfo, setDeriveInfo] = useState<string | null>(null);
  const deriveBrief = useMutation({
    mutationFn: (urls: string[]) => api.deriveBrief(urls),
    onSuccess: (res) => {
      s.set("productBrief", res.proposedBrief);
      const skipped = res.skipped.length > 0 ? ` · ${res.skipped.length} source(s) unreadable` : "";
      setDeriveInfo(
        `derived from ${res.sourceUrls.length} source(s) · $${res.costUsd.toFixed(2)}${skipped} — edit before saving`,
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <SectionShell
      {...s.shell}
      lede="What your replies are allowed to know and cite. Facts, architecture, pricing model, canonical links. A link that isn't in this brief is never sent."
      saveDisabled={deriveBrief.isPending}
      saveTitle={
        deriveBrief.isPending ? "wait for the brief derive to finish, then save" : undefined
      }
    >
      <Field
        label="Derive from sources"
        hint="One URL per line — your site, the GitHub repo, docs pages (max 5). Each is one webRead (~$0.01); you edit the proposal before saving."
      >
        <div className="flex gap-2">
          <Textarea
            value={briefSources}
            onChange={(e) => setBriefSources(e.target.value)}
            placeholder={"yourproduct.com\ngithub.com/you/your-repo\ndocs.yourproduct.com/pricing"}
            rows={3}
          />
          <Button
            type="button"
            variant="secondary"
            className="shrink-0 self-start whitespace-nowrap"
            disabled={deriveBrief.isPending || briefSources.trim().length === 0}
            onClick={() =>
              deriveBrief.mutate(
                briefSources
                  .split("\n")
                  .map((u) => u.trim())
                  .filter((u) => u.length > 0)
                  .slice(0, 5),
              )
            }
            {...readOnly}
          >
            <Wand2 size={12} className={deriveBrief.isPending ? "animate-pulse" : undefined} />
            {deriveBrief.isPending ? "Reading sources…" : "Derive brief"}
          </Button>
        </div>
      </Field>
      {deriveInfo && <div className="font-mono text-[11px] text-ink-faint">{deriveInfo}</div>}
      <Field
        label="Product brief"
        hint="Used by /inbox reply drafting to answer substantive questions with substance. Keep links verbatim."
      >
        <Textarea
          value={s.values.productBrief}
          onChange={(e) => s.set("productBrief", e.target.value)}
          placeholder="How it works: … settled per call in USDC on Base …\nPricing: …\nLinks:\nhttps://docs.yourproduct.com/payments"
          rows={8}
        />
      </Field>
    </SectionShell>
  );
}
