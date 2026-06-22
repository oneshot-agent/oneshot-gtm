import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Mail, Save, Wand2 } from "lucide-react";
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
  GMAIL_CLIENT_ID: "GMAIL_CLIENT_ID",
  GMAIL_CLIENT_SECRET: "GMAIL_CLIENT_SECRET",
  GMAIL_REFRESH_TOKEN: "GMAIL_REFRESH_TOKEN",
};

function SetupPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: api.doctor });

  const [founderName, setFounderName] = useState("");
  const [founderEmail, setFounderEmail] = useState("");
  const [productOneLiner, setProductOneLiner] = useState("");
  const [productDomain, setProductDomain] = useState("");
  const [sendingDomain, setSendingDomain] = useState("");
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
  const [emailProvider, setEmailProvider] = useState<"oneshot" | "gmail">("oneshot");
  // Sender-rotation pool edits, applied on Save: per-identity cap inputs
  // (string so the field can be temporarily empty) + pending removals.
  const [capEdits, setCapEdits] = useState<Record<string, string>>({});
  const [removedIdentityIds, setRemovedIdentityIds] = useState<string[]>([]);
  // Pending OneShot sender identities to add on Save. Each is a wallet-owned
  // domain + mailbox local-part; cap blank = cold-start warm-up ramp.
  const [pendingAdds, setPendingAdds] = useState<
    Array<{ sendingDomain: string; mailbox: string; maxPerDay: string }>
  >([]);
  const [addDomain, setAddDomain] = useState("");
  const [addMailbox, setAddMailbox] = useState("");
  const [addCap, setAddCap] = useState("");
  const [founderCredentials, setFounderCredentials] = useState("");
  const [productPortfolio, setProductPortfolio] = useState("");
  const [partners, setPartners] = useState("");
  const [mobileSignature, setMobileSignature] = useState(false);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!status.data?.cfg) return;
    const c = status.data.cfg;
    setFounderName(c.founderName ?? "");
    setFounderEmail(c.founderEmail ?? "");
    setProductOneLiner(c.productOneLiner ?? "");
    setProductDomain(c.productDomain ?? "");
    setSendingDomain(c.sendingDomain ?? "");
    setIcpOneLiner(c.icpOneLiner ?? "");
    setFounderCredentials(c.founderCredentials ?? "");
    setProductPortfolio(c.productPortfolio ?? "");
    setPartners(c.partners ?? "");
    setMobileSignature(c.mobileSignature ?? false);
    setLlmProvider(c.llmProvider);
    setLlmModel(c.llmModel || LLM_DEFAULTS[c.llmProvider] || "");
    setTelemetryEnabled(c.telemetryEnabled);
    setWalletMode(c.walletMode);
    setEmailProvider(c.emailProvider);
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

  // Resume / pause a provisioned sending domain in the OneShot pool. Refetches
  // the setup status (and doctor) so the status badge + warning update. Errors
  // surface verbatim — incl. the OneShot HTTP status during a platform outage.
  const domainAction = useMutation({
    mutationFn: (vars: { domain: string; action: "resume" | "pause" }) =>
      vars.action === "resume" ? api.resumeDomain(vars.domain) : api.pauseDomain(vars.domain),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["setup"] });
      void qc.invalidateQueries({ queryKey: ["doctor"] });
      toast.success(`${res.domain} → ${res.poolStatus}`);
    },
    onError: (err: Error) => toast.error(err.message),
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
      const identityUpdates = Object.entries(capEdits).map(([id, raw]) => {
        const n = Number.parseInt(raw, 10);
        return { id, maxPerDay: Number.isFinite(n) && n >= 0 ? n : null };
      });
      const addIdentities = pendingAdds.map((a) => {
        const n = Number.parseInt(a.maxPerDay, 10);
        return {
          provider: "oneshot" as const,
          sendingDomain: a.sendingDomain,
          ...(a.mailbox.trim() ? { mailbox: a.mailbox.trim() } : {}),
          // Blank cap = omit → cold-start ramp; a number = explicit cap.
          ...(a.maxPerDay.trim() && Number.isFinite(n) && n >= 0 ? { maxPerDay: n } : {}),
        };
      });
      await api.setup({
        ...(identityUpdates.length > 0 ? { identityUpdates } : {}),
        ...(addIdentities.length > 0 ? { addIdentities } : {}),
        ...(removedIdentityIds.length > 0 ? { removeIdentityIds: removedIdentityIds } : {}),
        founderName,
        founderEmail,
        productOneLiner,
        productDomain,
        sendingDomain,
        icpOneLiner,
        founderCredentials,
        productPortfolio,
        partners,
        mobileSignature,
        llmProvider,
        llmModel,
        telemetryEnabled,
        walletMode,
        emailProvider,
        secrets: filteredSecrets as never,
      });
    },
    onSuccess: () => {
      setSecrets({});
      setCapEdits({});
      setRemovedIdentityIds([]);
      setPendingAdds([]);
      setAddDomain("");
      setAddMailbox("");
      setAddCap("");
      setSavedAt(Date.now());
      void qc.invalidateQueries({ queryKey: ["setup"] });
      void qc.invalidateQueries({ queryKey: ["doctor"] });
      void qc.invalidateQueries({ queryKey: ["home"] });
    },
  });

  const sources = status.data?.sources ?? {};
  const provisionedDomains = status.data?.provisionedDomains ?? [];
  // Default mailbox shown as a placeholder — founder's first name, normalized.
  const founderLocalpart =
    (founderName.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") || "";
  // Legacy single-identity mode = the pool is auto-derived from emailProvider.
  // Once a real pool exists, the provider select / manual Gmail secrets are
  // inert (routing is pool-driven) — hide them instead of misleading.
  const isLegacyPool = status.data?.identities?.[0]?.legacy ?? true;
  // The Connect button needs the shared OAuth-app creds saved first.
  const gmailCredsReady = Boolean(sources["GMAIL_CLIENT_ID"] && sources["GMAIL_CLIENT_SECRET"]);

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
    window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    void qc.invalidateQueries({ queryKey: ["setup"] });
    void qc.invalidateQueries({ queryKey: ["doctor"] });
  }, [qc]);
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
              label="Signature domain"
              hint="Bare domain shown under your name in every email signature, e.g. yourcompany.com. Leave blank for no domain line."
            >
              <Input
                value={productDomain}
                onChange={(e) => setProductDomain(e.target.value)}
                placeholder="yourcompany.com"
              />
            </Field>
            <Field
              label="Sending domain"
              hint="The domain your wallet OWNS. Emails send from <your-first-name>@thisdomain. Must be wallet-owned or the SDK rejects the send. Leave blank to use the SDK default."
            >
              <Input
                value={sendingDomain}
                onChange={(e) => setSendingDomain(e.target.value)}
                placeholder="yourcompany-mail.com"
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
                placeholder={
                  'e.g. "Stripe for freight" · "AI bookkeeping for restaurants" · "scheduling for dog groomers"'
                }
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
                placeholder={
                  'e.g. "CFOs at Series-B SaaS" · "Shopify stores doing $1M+/yr" · "indie iOS devs"'
                }
                rows={3}
              />
            </Field>
          </div>
        </LedgerSection>

        <LedgerSection
          eyebrow="03 · Social proof"
          lede="All optional. Each maps to a different play type. Used by the LLM when drafting the second sentence of a first-touch email — never more than one beat per email."
        >
          <div className="grid grid-cols-1 gap-4">
            <Field
              label="Founder background"
              hint="Prior companies, named past roles, anything that lets a stranger trust you. Used by job-change / podcast-guest / post-funding / breakup-revive."
            >
              <Textarea
                value={founderCredentials}
                onChange={(e) => setFounderCredentials(e.target.value)}
                placeholder={
                  'e.g. "ex-Stripe eng" · "VP Sales at Salesforce" · "ran a $2M Shopify store"'
                }
                rows={2}
              />
            </Field>
            <Field
              label="Products you've shipped"
              hint="Used in peer-founder outreach to show you've actually built things. Stack-consolidation / competitor-switch / show-hn / hiring-signal."
            >
              <Textarea
                value={productPortfolio}
                onChange={(e) => setProductPortfolio(e.target.value)}
                placeholder="Comma-separated list of products or projects you've shipped."
                rows={2}
              />
            </Field>
            <Field
              label="Notable partners / customers"
              hint="Brand names that open doors. Helps when the prospect doesn't know you yet. Accelerator-batch / demo-no-show."
            >
              <Textarea
                value={partners}
                onChange={(e) => setPartners(e.target.value)}
                placeholder="Comma-separated brand-name integrations or customers."
                rows={2}
              />
            </Field>
            <Checkbox
              checked={mobileSignature}
              onChange={(e) => setMobileSignature(e.target.checked)}
              label={'Append "Sent from my iPhone" to every email signature'}
            />
          </div>
        </LedgerSection>

        <LedgerSection
          eyebrow="04 · LLM provider"
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
          eyebrow="05 · Wallet"
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
          eyebrow="06 · Email transport"
          lede="The sender rotation pool. Each prospect sticks to the identity that first emailed them; new prospects go to the identity with the most capacity left today."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {(status.data?.identities?.length ?? 0) > 0 && (
              <div className="md:col-span-2 flex flex-col gap-2">
                <span className="ln-eyebrow">Sender identities</span>
                {status
                  .data!.identities.filter((i) => !removedIdentityIds.includes(i.id))
                  .map((i) => (
                    <div
                      key={i.id}
                      className="flex items-center gap-3 border border-ink-rule rounded-[var(--radius-sm)] px-3 py-2"
                    >
                      <Badge tone={i.provider === "gmail" ? "signal" : "receipt"}>
                        {i.provider}
                      </Badge>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-[13px] text-ink-cream">
                          {i.mailbox && i.sendingDomain
                            ? `${i.mailbox}@${i.sendingDomain}`
                            : (i.address ?? i.sendingDomain ?? i.label ?? i.id)}
                        </span>
                        <span className="ln-mono text-[11px] text-ink-muted">
                          {i.domainSentToday !== i.sentToday
                            ? `today ${i.sentToday} · domain ${i.domainSentToday}/${i.capToday ?? "∞"} shared`
                            : `today ${i.sentToday}/${i.capToday ?? "∞"}`}
                          {i.warmup
                            ? ` · warm-up ${i.warmup.startPerDay}+${i.warmup.incrementPerWeek}/wk`
                            : ""}
                          {i.legacy ? " · legacy (auto-derived)" : ""}
                        </span>
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        <Input
                          className="h-7 w-20 text-[12px]"
                          placeholder={i.maxPerDay == null ? "∞" : String(i.maxPerDay)}
                          value={capEdits[i.id] ?? ""}
                          onChange={(e) => setCapEdits((m) => ({ ...m, [i.id]: e.target.value }))}
                          aria-label={`max sends per day for ${i.id}`}
                        />
                        <span className="ln-mono text-[10.5px] text-ink-faint">max/day</span>
                        {!i.legacy && (
                          <Button
                            type="button"
                            variant="secondary"
                            className="h-7 px-2 text-[11px]"
                            onClick={() => setRemovedIdentityIds((ids) => [...ids, i.id])}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!gmailCredsReady}
                    onClick={() => {
                      window.location.href = "/api/gmail/auth/start";
                    }}
                  >
                    <Mail size={12} />
                    Connect Gmail account
                  </Button>
                  <span className="text-[12px] text-ink-faint">
                    {gmailCredsReady
                      ? "Opens Google consent — sign in as the account you want to send from."
                      : "Save GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET below first (Google Cloud OAuth client, Desktop type, Gmail API enabled)."}
                  </span>
                </div>
                <span className="text-[12px] text-ink-faint">
                  CLI alternative:{" "}
                  <code className="ln-mono text-[11.5px] text-ink-cream-2">
                    bun run cli -- gmail auth
                  </code>
                  . Cap and removal changes apply on Save. Removing an identity blocks sends to
                  prospects pinned to it until it's restored.
                </span>

                {/* Provisioned domains: the wallet's OneShot sending-domain pool
                    with live status. A paused domain sends nothing until resumed
                    (doctor flags it); resume/pause act on it in place. */}
                {provisionedDomains.length > 0 && (
                  <div className="mt-3 flex flex-col gap-2 border-t border-ink-rule pt-3">
                    <span className="ln-eyebrow">Provisioned domains</span>
                    {provisionedDomains.map((d) => {
                      const paused = d.poolStatus === "paused" || d.poolStatus === "removed";
                      const tone =
                        d.poolStatus === "active"
                          ? "receipt"
                          : d.poolStatus === "warming"
                            ? "spend"
                            : "blocked";
                      const busy =
                        domainAction.isPending && domainAction.variables?.domain === d.domain;
                      return (
                        <div
                          key={d.domain}
                          className="flex items-center gap-3 border border-ink-rule rounded-[var(--radius-sm)] px-3 py-2"
                        >
                          <Badge tone={tone}>{d.poolStatus}</Badge>
                          <span className="truncate text-[13px] text-ink-cream">{d.domain}</span>
                          <span className="ln-mono text-[11px] text-ink-muted">
                            sent {d.dailySentCount}/{d.dailySendLimit}/day
                            {d.warmupScore != null ? ` · warmth ${d.warmupScore}` : ""}
                          </span>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={busy}
                            className="ml-auto h-7 px-2 text-[11px]"
                            onClick={() =>
                              domainAction.mutate({
                                domain: d.domain,
                                action: paused ? "resume" : "pause",
                              })
                            }
                          >
                            {busy ? "…" : paused ? "Resume" : "Pause"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Add OneShot sender: a wallet-owned domain + a mailbox local-part.
                    Multiple domains, and multiple mailboxes within one domain, all
                    join the rotation pool. Applied on Save. */}
                <div className="mt-3 flex flex-col gap-2 border-t border-ink-rule pt-3">
                  <span className="ln-eyebrow">Add OneShot sender</span>
                  {pendingAdds.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      {pendingAdds.map((a) => (
                        <div
                          key={`${a.mailbox || "agent"}@${a.sendingDomain}`}
                          className="flex items-center gap-3 border border-dashed border-ink-rule rounded-[var(--radius-sm)] px-3 py-1.5"
                        >
                          <Badge tone="receipt">oneshot</Badge>
                          <span className="truncate text-[13px] text-ink-cream">
                            {a.mailbox.trim() || "agent"}@{a.sendingDomain}
                          </span>
                          <span className="ln-mono text-[11px] text-ink-muted">
                            {a.maxPerDay.trim() ? `cap ${a.maxPerDay.trim()}/day` : "warm-up ramp"}
                          </span>
                          <Button
                            type="button"
                            variant="secondary"
                            className="ml-auto h-7 px-2 text-[11px]"
                            onClick={() => setPendingAdds((p) => p.filter((x) => x !== a))}
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Domain" className="min-w-[200px]">
                      {/* Free text + suggestions: pick a warmed domain or type a
                          new one (it auto-provisions on first send). */}
                      <Input
                        list="oneshot-domains"
                        placeholder="acme.com"
                        value={addDomain}
                        onChange={(e) => setAddDomain(e.target.value)}
                        aria-label="sending domain"
                      />
                      <datalist id="oneshot-domains">
                        {provisionedDomains.map((d) => (
                          <option key={d.domain} value={d.domain}>
                            {d.poolStatus !== "active" ? d.poolStatus : ""}
                            {d.warmupScore != null ? ` warmth ${d.warmupScore}` : ""}
                          </option>
                        ))}
                      </datalist>
                    </Field>
                    <Field label="Mailbox" className="w-32">
                      <Input
                        placeholder={founderLocalpart || "agent"}
                        value={addMailbox}
                        onChange={(e) => setAddMailbox(e.target.value)}
                        aria-label="mailbox local-part"
                      />
                    </Field>
                    <Field label="Max/day" className="w-24">
                      <Input
                        placeholder="ramp"
                        value={addCap}
                        onChange={(e) => setAddCap(e.target.value)}
                        aria-label="max sends per day"
                      />
                    </Field>
                    <Button
                      type="button"
                      variant="secondary"
                      className="mb-[2px]"
                      disabled={!addDomain.trim()}
                      onClick={() => {
                        const d = addDomain.trim().toLowerCase();
                        if (!d) return;
                        setPendingAdds((p) => [
                          ...p,
                          { sendingDomain: d, mailbox: addMailbox, maxPerDay: addCap },
                        ]);
                        setAddDomain("");
                        setAddMailbox("");
                        setAddCap("");
                      }}
                    >
                      Add
                    </Button>
                  </div>
                  {/* Cold-domain warning: a typed domain that isn't in the warmed
                      pool will go out cold (pinned sends bypass server warm-up). */}
                  {addDomain.trim() &&
                    provisionedDomains.length > 0 &&
                    !provisionedDomains.some(
                      (d) => d.domain.toLowerCase() === addDomain.trim().toLowerCase(),
                    ) && (
                      <span className="text-[12px] text-ink-blocked">
                        {addDomain.trim()} isn't in your warmed pool — it auto-provisions on first
                        send and goes out cold (server warm-up is bypassed for chosen domains). The
                        client ramp below is your only throttle.
                      </span>
                    )}
                  {/* Shared-reputation note when stacking a 2nd mailbox on a domain
                      already in the pool — reputation + send limits are per-domain. */}
                  {addDomain.trim() &&
                    (status.data?.identities ?? []).some(
                      (i) => i.sendingDomain?.toLowerCase() === addDomain.trim().toLowerCase(),
                    ) && (
                      <span className="text-[12px] text-ink-faint">
                        Heads up: {addDomain.trim()} already sends in your pool. Reputation and the
                        platform daily limit are per-domain — extra mailboxes share them, and their
                        client caps stack on the same domain.
                      </span>
                    )}
                  <span className="text-[12px] text-ink-faint">
                    Blank mailbox defaults to your first name; blank cap uses the cold-start warm-up
                    ramp (10/day, +10/week, max 50). Domains you send from are pinned, so the client
                    ramp — not the server — paces warm-up. New senders join the pool on Save.
                  </span>
                </div>
              </div>
            )}
            {!isLegacyPool && !gmailCredsReady && (
              <>
                <Field label="GMAIL_CLIENT_ID" hint={hintFor(sources["GMAIL_CLIENT_ID"])}>
                  <Input
                    type="password"
                    placeholder={sources["GMAIL_CLIENT_ID"] ? "(unchanged)" : ""}
                    value={secrets["GMAIL_CLIENT_ID"] ?? ""}
                    onChange={(e) => setSecret("GMAIL_CLIENT_ID", e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="GMAIL_CLIENT_SECRET" hint={hintFor(sources["GMAIL_CLIENT_SECRET"])}>
                  <Input
                    type="password"
                    placeholder={sources["GMAIL_CLIENT_SECRET"] ? "(unchanged)" : ""}
                    value={secrets["GMAIL_CLIENT_SECRET"] ?? ""}
                    onChange={(e) => setSecret("GMAIL_CLIENT_SECRET", e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
              </>
            )}
            {isLegacyPool && (
              <Field label="Provider" className="md:col-span-2">
                <Select
                  value={emailProvider}
                  onChange={(e) => setEmailProvider(e.target.value as typeof emailProvider)}
                >
                  <option value="oneshot">OneShot SDK (wallet-owned sending domain)</option>
                  <option value="gmail">Gmail / Google Workspace (your own account)</option>
                </Select>
              </Field>
            )}
            {isLegacyPool && emailProvider === "gmail" && (
              <>
                <div className="ln-note text-[12px] text-ink-muted md:col-span-2">
                  Emails send from your authenticated Gmail address — the sending domain above is
                  ignored. Easiest path: run{" "}
                  <code className="ln-mono text-[11.5px] text-ink-cream-2">
                    bun run cli -- gmail auth
                  </code>{" "}
                  to authorize in the browser and fill all three values automatically.
                </div>
                <Field label="GMAIL_CLIENT_ID" hint={hintFor(sources["GMAIL_CLIENT_ID"])}>
                  <Input
                    type="password"
                    placeholder={sources["GMAIL_CLIENT_ID"] ? "(unchanged)" : ""}
                    value={secrets["GMAIL_CLIENT_ID"] ?? ""}
                    onChange={(e) => setSecret("GMAIL_CLIENT_ID", e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="GMAIL_CLIENT_SECRET" hint={hintFor(sources["GMAIL_CLIENT_SECRET"])}>
                  <Input
                    type="password"
                    placeholder={sources["GMAIL_CLIENT_SECRET"] ? "(unchanged)" : ""}
                    value={secrets["GMAIL_CLIENT_SECRET"] ?? ""}
                    onChange={(e) => setSecret("GMAIL_CLIENT_SECRET", e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                <Field
                  label="GMAIL_REFRESH_TOKEN"
                  hint={hintFor(sources["GMAIL_REFRESH_TOKEN"])}
                  className="md:col-span-2"
                >
                  <Input
                    type="password"
                    placeholder={sources["GMAIL_REFRESH_TOKEN"] ? "(unchanged)" : ""}
                    value={secrets["GMAIL_REFRESH_TOKEN"] ?? ""}
                    onChange={(e) => setSecret("GMAIL_REFRESH_TOKEN", e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
              </>
            )}
          </div>
        </LedgerSection>

        <LedgerSection
          eyebrow="07 · Telemetry"
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
