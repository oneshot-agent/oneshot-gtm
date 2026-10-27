import { useMutation } from "@tanstack/react-query";
import { Plug, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { SourceRepoTestResult } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import {
  briefSectionRequest,
  shortCommit,
  sourceRepoError,
  sourceRepoField,
  sourceRepoRequest,
} from "../../lib/codeAnswers.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { Field, Input, Textarea } from "../primitives/Field.tsx";
import { CodeAnswersList } from "./CodeAnswersList.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

export function ProductBriefSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(
    () => ({
      productBrief: cfg.productBrief ?? "",
      sourceRepo: sourceRepoField(cfg.sourceRepo),
      sourceRef: cfg.sourceRepo?.ref ?? "",
      codeAnswerDisclosure: cfg.codeAnswerDisclosure ?? "",
    }),
    [cfg],
  );
  const s = useConfigSection({
    id: "brief",
    server,
    toRequest: (sent) => briefSectionRequest(sent, server),
    validate: (v) => ({ sourceRepo: sourceRepoError(v.sourceRepo) }),
    onDirtyChange,
  });
  // A result is shown only for the repo and ref it was read with: an edit
  // while a test runs hides the answer that arrives for the old values.
  const repoKey = JSON.stringify([s.values.sourceRepo.trim(), s.values.sourceRef.trim()]);
  const [tested, setTested] = useState<{ key: string; result: SourceRepoTestResult } | null>(null);
  const repoTest = tested?.key === repoKey ? tested.result : null;
  const testRepo = useMutation({
    mutationFn: async (key: string) => {
      const repo = sourceRepoRequest(s.values.sourceRepo, s.values.sourceRef) ?? {};
      try {
        return { key, result: await api.testSourceRepo(repo) };
      } catch (err) {
        return { key, result: { ok: false, error: (err as Error).message } };
      }
    },
    onSuccess: setTested,
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
      lede="What replies may know and cite. A link that isn't in here is never sent."
      saveDisabled={deriveBrief.isPending}
      saveTitle={
        deriveBrief.isPending ? "wait for the brief derive to finish, then save" : undefined
      }
    >
      <Field
        label="Derive from sources"
        hint="One URL per line, up to 5. About $0.01 each. Edit the draft before saving."
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
      <Field label="Product brief" hint="Grounds /inbox reply drafts. Keep links verbatim.">
        <Textarea
          value={s.values.productBrief}
          onChange={(e) => s.set("productBrief", e.target.value)}
          placeholder="How it works: … what a customer does in the first week …\nPricing: …\nLinks:\nhttps://docs.yourproduct.com/getting-started"
          rows={8}
        />
      </Field>
      <Field
        label="Source repo"
        hint="Read to answer how-it-works questions the brief doesn't. A GitHub URL (private repos use GITHUB_TOKEN) or a local checkout. Answers wait for your approval."
        error={s.errors.sourceRepo}
      >
        <div className="flex gap-2">
          <Input
            value={s.values.sourceRepo}
            onChange={(e) => s.set("sourceRepo", e.target.value)}
            placeholder="https://github.com/you/your-repo or /path/to/checkout"
          />
          <Input
            aria-label="Branch, tag or commit"
            className="max-w-[12rem]"
            value={s.values.sourceRef}
            onChange={(e) => s.set("sourceRef", e.target.value)}
            placeholder="default branch"
          />
          <Button
            type="button"
            variant="secondary"
            className="shrink-0 whitespace-nowrap"
            disabled={
              testRepo.isPending ||
              !s.values.sourceRepo.trim() ||
              Boolean(sourceRepoError(s.values.sourceRepo))
            }
            onClick={() => testRepo.mutate(repoKey)}
            {...readOnly}
          >
            <Plug size={12} className={testRepo.isPending ? "animate-pulse" : undefined} />
            {testRepo.isPending ? "Testing…" : "Test"}
          </Button>
        </div>
      </Field>
      {repoTest && <SourceRepoTestLine result={repoTest} />}
      <Field
        label="What answers may say"
        hint="Blank: behaviour only, what a caller observes. Never storage, file paths, internal names or environment."
      >
        <Textarea
          value={s.values.codeAnswerDisclosure}
          onChange={(e) => s.set("codeAnswerDisclosure", e.target.value)}
          placeholder="Behaviour only: what a caller sees, in plain words."
          rows={2}
        />
      </Field>
      <CodeAnswersList repoConfigured={Boolean(cfg.sourceRepo?.url || cfg.sourceRepo?.path)} />
    </SectionShell>
  );
}

export function SourceRepoTestLine({ result }: { result: SourceRepoTestResult }) {
  if (!result.ok)
    return (
      <div role="alert" className="font-mono text-[11px] text-ink-blocked-2">
        can't read it · {result.error ?? "unknown error"}
      </div>
    );
  const parts = [
    `readable${result.backend ? ` via ${result.backend === "github" ? "GitHub" : "local checkout"}` : ""}`,
    result.ref && result.commit ? `${result.ref} @ ${shortCommit(result.commit)}` : null,
    result.readableFiles != null ? `${result.readableFiles} files the answers may read` : null,
  ].filter(Boolean);
  return (
    <div role="status" className="font-mono text-[11px] text-ink-faint">
      {parts.join(" · ")}
    </div>
  );
}
