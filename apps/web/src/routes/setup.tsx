import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Save, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { Card, CardBody, CardHeader } from "../components/primitives/Card.tsx";
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-zinc-100">Setup</h1>
        <span className="text-xs text-zinc-500">
          Saved to <code>~/.oneshot-gtm/config.json</code> + <code>.env</code> (chmod 600)
        </span>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="flex flex-col gap-6"
      >
        <Card>
          <CardHeader>Founder profile</CardHeader>
          <CardBody className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
            <Field label="Product one-liner" hint="What you're building, in one sentence.">
              <Textarea
                value={productOneLiner}
                onChange={(e) => setProductOneLiner(e.target.value)}
                placeholder="Open-source GTM agent for technical founders, paid per-result."
                rows={2}
                className="md:col-span-2"
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>Ideal customer profile (ICP)</CardHeader>
          <CardBody className="flex flex-col gap-4">
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
                  disabled={deriveIcp.isPending || icpDomain.trim().length === 0}
                  onClick={() => deriveIcp.mutate(icpDomain.trim())}
                >
                  <Wand2 size={12} />
                  {deriveIcp.isPending ? "Reading…" : "Derive ICP"}
                </Button>
              </div>
            </Field>

            {icpDeriveError && (
              <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {icpDeriveError}
              </div>
            )}
            {icpDeriveSource && !icpDeriveError && (
              <div className="text-xs text-zinc-500">
                Drafted from{" "}
                <a
                  href={icpDeriveSource.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-zinc-300 underline"
                >
                  {icpDeriveSource.url}
                </a>{" "}
                · spent ${icpDeriveSource.cost.toFixed(3)}. Edit below before saving.
              </div>
            )}

            <Field
              label="ICP one-liner"
              hint="The find layer's classifier uses this to drop candidates that don't match — strict by design. Leave blank to disable filtering (every candidate passes through)."
            >
              <Textarea
                value={icpOneLiner}
                onChange={(e) => setIcpOneLiner(e.target.value)}
                placeholder="Developers shipping autonomous AI agents who need deterministic spend tracking and on-chain receipts."
                rows={3}
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>LLM provider</CardHeader>
          <CardBody className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
            >
              <Input
                type="password"
                placeholder={sources[llmSecretKey] ? "(unchanged)" : "sk-..."}
                value={secrets[llmSecretKey] ?? ""}
                onChange={(e) => setSecret(llmSecretKey, e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>OneShot wallet</CardHeader>
          <CardBody className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Wallet mode">
              <Select
                value={walletMode}
                onChange={(e) => setWalletMode(e.target.value as typeof walletMode)}
              >
                <option value="cdp">Coinbase CDP server wallet</option>
                <option value="private-key">Raw private key</option>
              </Select>
            </Field>
            <div />
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
                <Field label="CDP_WALLET_SECRET" hint={hintFor(sources["CDP_WALLET_SECRET"])}>
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
              <Field label="AGENT_PRIVATE_KEY" hint={hintFor(sources["AGENT_PRIVATE_KEY"])}>
                <Input
                  type="password"
                  placeholder={sources["AGENT_PRIVATE_KEY"] ? "(unchanged)" : "0x..."}
                  value={secrets["AGENT_PRIVATE_KEY"] ?? ""}
                  onChange={(e) => setSecret("AGENT_PRIVATE_KEY", e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>Telemetry</CardHeader>
          <CardBody>
            <Checkbox
              label="Send anonymous opt-out telemetry (commands run, no data, no PII — see TELEMETRY.md)"
              checked={telemetryEnabled}
              onChange={(e) => setTelemetryEnabled(e.target.checked)}
            />
          </CardBody>
        </Card>

        <div className="flex items-center justify-between gap-4">
          <div className="text-xs text-zinc-500">
            {save.isError && <span className="text-red-400">{save.error.message}</span>}
            {save.isSuccess && savedAt != null && <span className="text-emerald-400">Saved.</span>}
          </div>
          <Button type="submit" disabled={save.isPending}>
            <Save size={14} />
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>

      <Card>
        <CardHeader>Doctor</CardHeader>
        <CardBody className="flex flex-col gap-1.5 text-sm">
          {doctor.data?.checks.map((c) => (
            <div key={c.name} className="flex items-center gap-2">
              {c.severity === "ok" && <Badge tone="green">ok</Badge>}
              {c.severity === "warn" && <Badge tone="yellow">warn</Badge>}
              {c.severity === "fail" && <Badge tone="red">fail</Badge>}
              <span className="text-zinc-400">{c.name}</span>
              <span className="text-zinc-200">{c.message}</span>
              {c.hint && <span className="text-zinc-500">→ {c.hint}</span>}
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

function hintFor(source: "env" | "file" | null | undefined): string {
  if (source === "env") return "Currently from shell env. Leave blank to keep.";
  if (source === "file") return "Currently from ~/.oneshot-gtm/.env. Leave blank to keep.";
  return "Not set yet.";
}
