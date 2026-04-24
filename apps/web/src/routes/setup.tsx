import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Save, Wand2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { Checkbox, Field, Input, Select, Textarea } from "../components/primitives/Field.tsx";

export const Route = createFileRoute("/setup")({
  component: SetupPage,
});

const LLM_DEFAULTS: Record<string, string> = {
  openrouter: "anthropic/claude-sonnet-4.6",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-6",
};

const SECRET_LABELS: Record<string, string> = {
  OPENROUTER_API_KEY: "OpenRouter API key",
  OPENAI_API_KEY: "OpenAI API key",
  ANTHROPIC_API_KEY: "Anthropic API key",
  CDP_API_KEY_ID: "CDP_API_KEY_ID",
  CDP_API_KEY_SECRET: "CDP_API_KEY_SECRET",
  CDP_WALLET_SECRET: "CDP_WALLET_SECRET",
  AGENT_PRIVATE_KEY: "AGENT_PRIVATE_KEY",
};

function SetupPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: api.doctor });

  const [founderName, setFounderName] = useState("");
  const [founderEmail, setFounderEmail] = useState("");
  const [productOneLiner, setProductOneLiner] = useState("");
  const [icpOneLiner, setIcpOneLiner] = useState("");
  const [icpDomain, setIcpDomain] = useState("");
  const [icpDeriveError, setIcpDeriveError] = useState<string | null>(null);
  const [icpDeriveSource, setIcpDeriveSource] = useState<{ url: string; cost: number } | null>(
    null,
  );
  const [llmProvider, setLlmProvider] = useState<"openrouter" | "openai" | "anthropic">(
    "openrouter",
  );
  const [llmModel, setLlmModel] = useState("");
  const [telemetryEnabled, setTelemetryEnabled] = useState(true);
  const [walletMode, setWalletMode] = useState<"cdp" | "private-key">("cdp");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!status.data?.cfg) return;
    const c = status.data.cfg;
    setFounderName(c.founderName ?? "");
    setFounderEmail(c.founderEmail ?? "");
    setProductOneLiner(c.productOneLiner ?? "");
    setIcpOneLiner(c.icpOneLiner ?? "");
    setLlmProvider(c.llmProvider);
    setLlmModel(c.llmModel || LLM_DEFAULTS[c.llmProvider] || "");
    setTelemetryEnabled(c.telemetryEnabled);
    setWalletMode(c.walletMode);
  }, [status.data?.cfg]);

  const deriveIcp = useMutation({
    mutationFn: (domain: string) => api.deriveIcp(domain),
    onSuccess: (res) => {
      setIcpOneLiner(res.proposedIcp);
      setIcpDeriveSource({ url: res.sourceUrl, cost: res.costUsd });
      setIcpDeriveError(null);
    },
    onError: (err: Error) => {
      setIcpDeriveError(err.message);
      setIcpDeriveSource(null);
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

  const save = useMutation({
    mutationFn: async () => {
      const filteredSecrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(secrets)) {
        if (v.trim().length > 0) filteredSecrets[k] = v.trim();
      }
      await api.setup({
        founderName,
        founderEmail,
        productOneLiner,
        icpOneLiner,
        llmProvider,
        llmModel,
        telemetryEnabled,
        walletMode,
        secrets: filteredSecrets as never,
      });
    },
    onSuccess: () => {
      setSecrets({});
      setSavedAt(Date.now());
      void qc.invalidateQueries({ queryKey: ["setup"] });
      void qc.invalidateQueries({ queryKey: ["doctor"] });
      void qc.invalidateQueries({ queryKey: ["home"] });
    },
  });

  const sources = status.data?.sources ?? {};
  const llmSecretKey =
    llmProvider === "openrouter"
      ? "OPENROUTER_API_KEY"
      : llmProvider === "openai"
        ? "OPENAI_API_KEY"
        : "ANTHROPIC_API_KEY";

  const setSecret = (key: string, value: string): void => {
    setSecrets((s) => ({ ...s, [key]: value }));
  };

  useEffect(() => {
    if (save.isError) toast.error(`couldn't save · ${save.error.message}`);
  }, [save.isError, save.error]);

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      {/* Masthead */}
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
          saved to <span className="text-ink-muted">~/.oneshot-gtm/config.json</span> ·{" "}
          <span className="text-ink-muted">.env</span> · chmod 600
        </span>
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="flex flex-col"
      >
        <LedgerSection
          eyebrow="01 · Founder profile"
          lede="How prospects see you on the other side of the inbox."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Name">
              <Input
                value={founderName}
                onChange={(e) => setFounderName(e.target.value)}
                placeholder="Jane Doe"
              />
            </Field>
            <Field label="Reply-to email">
              <Input
                type="email"
                value={founderEmail}
                onChange={(e) => setFounderEmail(e.target.value)}
                placeholder="jane@yourcompany.com"
              />
            </Field>
            <Field
              label="Product one-liner"
              hint="What you're building, in one sentence."
              className="md:col-span-2"
            >
              <Textarea
                value={productOneLiner}
                onChange={(e) => setProductOneLiner(e.target.value)}
                placeholder="Open-source GTM agent for technical founders, paid per-result."
                rows={2}
              />
            </Field>
          </div>
        </LedgerSection>

        <LedgerSection
          eyebrow="02 · Ideal customer profile"
          lede="A free-text classifier. The find layer uses this to drop candidates that don't match."
        >
          <div className="flex flex-col gap-4">
            <Field
              label="Derive from a website"
              hint="Paste a domain (or full URL) of a company whose customers look like yours. We'll read the page and propose an ICP — you can edit before saving. Spends ~$0.02–0.05 (one webRead + one LLM call)."
            >
              <div className="flex gap-2">
                <Input
                  value={icpDomain}
                  onChange={(e) => setIcpDomain(e.target.value)}
                  placeholder="acme.com  ·  https://yourcompany.com/customers"
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
                >
                  <Wand2
                    size={12}
                    className={deriveIcp.isPending ? "animate-pulse" : undefined}
                  />
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

            {icpDeriveError && (
              <div className="border-l-2 border-[color:var(--ink-blocked)] bg-[color:var(--ink-blocked)]/10 px-3 py-2 font-mono text-[11.5px] text-[color:var(--ink-blocked-2)]">
                {icpDeriveError}
              </div>
            )}
            {icpDeriveSource && !icpDeriveError && (
              <div className="font-mono text-[11px] text-ink-muted">
                drafted from{" "}
                <a
                  href={icpDeriveSource.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink-cream-2 underline decoration-ink-faint decoration-1 underline-offset-2 hover:decoration-ink-cream"
                >
                  {icpDeriveSource.url}
                </a>{" "}
                · spent ${icpDeriveSource.cost.toFixed(3)} · edit below before saving.
              </div>
            )}

            <Field
              label="ICP one-liner"
              hint="Leave blank to disable filtering (every candidate passes through)."
            >
              <Textarea
                value={icpOneLiner}
                onChange={(e) => setIcpOneLiner(e.target.value)}
                placeholder="Developers shipping autonomous AI agents who need deterministic spend tracking and on-chain receipts."
                rows={3}
              />
            </Field>
          </div>
        </LedgerSection>

        <LedgerSection
          eyebrow="03 · LLM provider"
          lede="Bring your own key. Swap providers freely; nothing is locked in."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Provider">
              <Select
                value={llmProvider}
                onChange={(e) => {
                  const v = e.target.value as typeof llmProvider;
                  setLlmProvider(v);
                  if (!llmModel) setLlmModel(LLM_DEFAULTS[v] ?? "");
                }}
              >
                <option value="openrouter">OpenRouter (recommended)</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </Select>
            </Field>
            <Field label="Model">
              <Input
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                placeholder={LLM_DEFAULTS[llmProvider]}
              />
            </Field>
            <Field
              label={SECRET_LABELS[llmSecretKey] ?? llmSecretKey}
              hint={
                sources[llmSecretKey] === "env"
                  ? "Currently from shell env. Leaving blank keeps the env value."
                  : sources[llmSecretKey] === "file"
                    ? "Currently from ~/.oneshot-gtm/.env. Leave blank to keep."
                    : "Not set. Paste it here to save (chmod 600)."
              }
              className="md:col-span-2"
            >
              <Input
                type="password"
                placeholder={sources[llmSecretKey] ? "(unchanged)" : "sk-..."}
                value={secrets[llmSecretKey] ?? ""}
                onChange={(e) => setSecret(llmSecretKey, e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
        </LedgerSection>

        <LedgerSection
          eyebrow="04 · OneShot wallet"
          lede="Keys live only in ~/.oneshot-gtm/.env chmod 600. Nothing leaves your machine."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Wallet mode" className="md:col-span-2">
              <Select
                value={walletMode}
                onChange={(e) => setWalletMode(e.target.value as typeof walletMode)}
              >
                <option value="cdp">Coinbase CDP server wallet</option>
                <option value="private-key">Raw private key</option>
              </Select>
            </Field>
            {walletMode === "cdp" ? (
              <>
                <Field label="CDP_API_KEY_ID" hint={hintFor(sources["CDP_API_KEY_ID"])}>
                  <Input
                    type="password"
                    placeholder={sources["CDP_API_KEY_ID"] ? "(unchanged)" : ""}
                    value={secrets["CDP_API_KEY_ID"] ?? ""}
                    onChange={(e) => setSecret("CDP_API_KEY_ID", e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="CDP_API_KEY_SECRET" hint={hintFor(sources["CDP_API_KEY_SECRET"])}>
                  <Input
                    type="password"
                    placeholder={sources["CDP_API_KEY_SECRET"] ? "(unchanged)" : ""}
                    value={secrets["CDP_API_KEY_SECRET"] ?? ""}
                    onChange={(e) => setSecret("CDP_API_KEY_SECRET", e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                <Field
                  label="CDP_WALLET_SECRET"
                  hint={hintFor(sources["CDP_WALLET_SECRET"])}
                  className="md:col-span-2"
                >
                  <Input
                    type="password"
                    placeholder={sources["CDP_WALLET_SECRET"] ? "(unchanged)" : ""}
                    value={secrets["CDP_WALLET_SECRET"] ?? ""}
                    onChange={(e) => setSecret("CDP_WALLET_SECRET", e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
              </>
            ) : (
              <Field
                label="AGENT_PRIVATE_KEY"
                hint={hintFor(sources["AGENT_PRIVATE_KEY"])}
                className="md:col-span-2"
              >
                <Input
                  type="password"
                  placeholder={sources["AGENT_PRIVATE_KEY"] ? "(unchanged)" : "0x..."}
                  value={secrets["AGENT_PRIVATE_KEY"] ?? ""}
                  onChange={(e) => setSecret("AGENT_PRIVATE_KEY", e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            )}
          </div>
        </LedgerSection>

        <LedgerSection
          eyebrow="05 · Telemetry"
          lede="Off by default for your data, on by default for command-run counts. Opt out at will."
        >
          <Checkbox
            label="Send anonymous opt-out telemetry (commands run, no data, no PII — see TELEMETRY.md)"
            checked={telemetryEnabled}
            onChange={(e) => setTelemetryEnabled(e.target.checked)}
          />
        </LedgerSection>

        <div className="sticky bottom-0 z-10 flex items-center justify-between gap-4 border-b border-t border-ink-rule bg-ink-bg/90 px-6 py-3 backdrop-blur-[2px]">
          <div className="font-mono text-[11px] text-ink-muted">
            {save.isSuccess && savedAt != null ? (
              <span className="text-[color:var(--ink-receipt-2)]">
                · saved to <span className="text-ink-cream-2">.env</span>
              </span>
            ) : (
              <span className="text-ink-faint">changes apply on save</span>
            )}
          </div>
          <Button type="submit" disabled={save.isPending}>
            <Save size={14} />
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>

      <LedgerSection
        eyebrow="— · Doctor"
        lede="Health of the local install. Run `oneshot-gtm doctor` for the CLI view."
      >
        <div className="flex flex-col gap-1.5">
          {doctor.data?.checks.map((c) => (
            <div key={c.name} className="flex items-center gap-2 text-[13px]">
              {c.severity === "ok" && <Badge tone="receipt">ok</Badge>}
              {c.severity === "warn" && <Badge tone="spend">warn</Badge>}
              {c.severity === "fail" && <Badge tone="blocked">fail</Badge>}
              <span className="text-ink-muted">{c.name}</span>
              <span className="text-ink-cream">{c.message}</span>
              {c.hint && <span className="ln-note text-ink-muted">→ {c.hint}</span>}
            </div>
          ))}
        </div>
      </LedgerSection>
    </div>
  );
}

function LedgerSection({
  eyebrow,
  lede,
  children,
}: {
  eyebrow: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-1 gap-6 border-b border-ink-rule px-6 py-6 lg:grid-cols-[220px_1fr]">
      <div>
        <div className="ln-eyebrow">{eyebrow}</div>
        {lede && <p className="ln-note mt-2 max-w-[32ch] text-[13px] text-ink-cream-2">{lede}</p>}
      </div>
      <div>{children}</div>
    </section>
  );
}

function hintFor(source: "env" | "file" | null | undefined): string {
  if (source === "env") return "Currently from shell env. Leave blank to keep.";
  if (source === "file") return "Currently from ~/.oneshot-gtm/.env. Leave blank to keep.";
  return "Not set yet.";
}
