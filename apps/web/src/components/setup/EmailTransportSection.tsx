import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
  DomainPoolView,
  SenderIdentityView,
  SetupRequest,
  SmartleadAccountView,
} from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { readOnly } from "../../lib/readOnly.ts";
import {
  buildIdentityPoolRequest,
  capText,
  parseCap,
  type PendingOneShotAdd,
} from "../../lib/setupValidation.ts";
import { Badge } from "../primitives/Badge.tsx";
import { Button } from "../primitives/Button.tsx";
import { Field, Input, Select } from "../primitives/Field.tsx";
import { CredentialsLink } from "./KeyStatusLine.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useIdentityStaging } from "./useIdentityStaging.ts";
import { useSectionDraft } from "./useSectionDraft.ts";
import { useSectionSave } from "./useSectionSave.ts";
import { useReportDirty, type SectionProps, type SetupStatus } from "./types.ts";

/**
 * The sender rotation pool. Cap edits, removals, new OneShot senders and
 * picked Smartlead mailboxes are STAGED and commit together in one POST on
 * this section's Save — never as a side effect of saving another section.
 * Pause/resume of a provisioned domain is the one immediate action here.
 */
export function EmailTransportSection({
  status,
  smartleadKeyEpoch,
  onDirtyChange,
}: Pick<SectionProps, "onDirtyChange"> & {
  status: SetupStatus;
  /** Bumped when Credentials saves a new Smartlead key: the loaded list belongs to the old one. */
  smartleadKeyEpoch: number;
}) {
  const qc = useQueryClient();
  const { cfg, sources } = status;
  const identities = status.identities ?? [];
  const provisionedDomains = status.provisionedDomains ?? [];
  // Legacy single-identity mode = the pool is auto-derived from emailProvider.
  // Once a real pool exists, the provider select is inert (routing is
  // pool-driven) — hide it instead of misleading.
  const isLegacyPool = identities[0]?.legacy ?? true;
  const gmailCredsReady = Boolean(sources["GMAIL_CLIENT_ID"] && sources["GMAIL_CLIENT_SECRET"]);
  const smartleadKeyReady = Boolean(sources["SMARTLEAD_API_KEY"]);
  // Default mailbox shown as a placeholder — founder's first name, normalized.
  const founderLocalpart = ((cfg.founderName ?? "").trim().split(/\s+/)[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  const server = useMemo(() => ({ emailProvider: cfg.emailProvider }), [cfg.emailProvider]);
  const draft = useSectionDraft(server);
  const staging = useIdentityStaging();

  const build = buildIdentityPoolRequest({
    identities: identities.map((i) => ({ id: i.id, maxPerDay: i.maxPerDay })),
    capEdits: staging.capEdits,
    removedIds: staging.removedIds,
    pendingAdds: staging.pendingAdds,
    pendingSmartleadAdds: staging.pendingSmartleadAdds,
    emailProvider: draft.snapshot.emailProvider,
  });
  const capErrors = build.ok ? {} : build.errors.caps;
  const addErrors = build.ok ? {} : build.errors.adds;
  const errorCount = Object.keys(capErrors).length + Object.keys(addErrors).length;
  const liveIds = new Set(identities.map((i) => i.id));
  const removed = staging.removedIds.filter((id) => liveIds.has(id));
  const capDirty = identities.filter(
    (i) =>
      !removed.includes(i.id) &&
      staging.capEdits[i.id] !== undefined &&
      staging.capEdits[i.id] !== capText(i.maxPerDay),
  ).length;
  const dirtyCount =
    capDirty +
    removed.length +
    staging.pendingAdds.length +
    staging.pendingSmartleadAdds.length +
    draft.dirtyKeys.length;

  const save = useSectionSave<SetupRequest>({
    save: async (req) => {
      await api.setup(req);
    },
    refetch: [["setup"]],
    alsoInvalidate: [["doctor"], ["home"]],
    onCommitted: (sent) => {
      staging.clear();
      if (sent.emailProvider !== undefined) draft.commit({ emailProvider: sent.emailProvider });
    },
  });
  useReportDirty("email", dirtyCount > 0, onDirtyChange);

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

  // Smartlead workspace mailboxes — loaded with the SAVED key (the input now
  // lives in Credentials). A saved key change invalidates the list and any
  // staged picks: they'd register mailboxes the new key can't send as.
  const [smartleadAccounts, setSmartleadAccounts] = useState<SmartleadAccountView[] | null>(null);
  const loadSmartlead = useMutation({
    mutationFn: () => api.smartleadAccounts(undefined),
    onSuccess: (res) => setSmartleadAccounts(res.accounts),
    onError: (err: Error) => toast.error(`Smartlead: ${err.message}`),
  });
  const { clearSmartlead } = staging;
  useEffect(() => {
    if (smartleadKeyEpoch === 0) return;
    setSmartleadAccounts(null);
    clearSmartlead();
  }, [smartleadKeyEpoch, clearSmartlead]);

  return (
    <SectionShell
      id="email"
      lede="The sender rotation pool. Each prospect sticks to the identity that first emailed them; new prospects go to the identity with the most capacity left today."
      dirtyCount={dirtyCount}
      errorCount={errorCount}
      savedAt={save.savedAt}
      saving={save.isPending}
      onSubmit={() => {
        if (build.ok && !build.empty) save.run(build.request);
      }}
      saveLabel="Save pool changes"
      footerNote="cap, removal and sender changes apply together on save"
    >
      {identities.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="ln-eyebrow">Sender identities</span>
          {identities
            .filter((i) => !removed.includes(i.id))
            .map((i) => (
              <IdentityRow
                key={i.id}
                identity={i}
                capValue={staging.capEdits[i.id] ?? capText(i.maxPerDay)}
                capError={capErrors[i.id]}
                onCap={(raw) => staging.setCap(i.id, raw)}
                onRemove={() => staging.remove(i.id)}
              />
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
              {gmailCredsReady ? (
                "Opens Google consent — sign in as the account you want to send from."
              ) : (
                <>
                  Save GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET in <CredentialsLink /> first (Google
                  Cloud OAuth client, Desktop type, Gmail API enabled).
                </>
              )}
            </span>
          </div>
          <span className="text-[12px] text-ink-faint">
            CLI alternative:{" "}
            <code className="ln-mono text-[11.5px] text-ink-cream-2">
              bun run cli -- gmail auth
            </code>
            . Cap and removal changes apply on Save. Removing an identity blocks sends to prospects
            pinned to it until it's restored.
          </span>

          <ProvisionedDomains
            domains={provisionedDomains}
            busyDomain={domainAction.isPending ? domainAction.variables?.domain : undefined}
            onToggle={(domain, action) => domainAction.mutate({ domain, action })}
          />

          <AddOneShotSender
            identities={identities}
            provisionedDomains={provisionedDomains}
            founderLocalpart={founderLocalpart}
            pending={staging.pendingAdds}
            pendingErrors={addErrors}
            onStage={staging.stageAdd}
            onUnstage={staging.unstageAdd}
          />
        </div>
      )}

      {/* Smartlead lives OUTSIDE the identities guard — connecting it is how an
          empty pool gets rebuilt. */}
      <div className="mt-3 flex flex-col gap-2">
        <span className="ln-eyebrow">Smartlead accounts</span>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={!smartleadKeyReady || loadSmartlead.isPending}
            onClick={() => loadSmartlead.mutate()}
            {...readOnly}
          >
            {loadSmartlead.isPending ? "Loading…" : "Load Smartlead accounts"}
          </Button>
          <span className="text-[12px] text-ink-faint">
            {smartleadKeyReady ? (
              "Lists the mailboxes connected to your Smartlead workspace — Smartlead does the warmup, this pool does the sending."
            ) : (
              <>
                Save your Smartlead API key in <CredentialsLink /> first (Smartlead → Settings →
                API).
              </>
            )}
          </span>
        </div>
        {smartleadAccounts && smartleadAccounts.length === 0 && (
          <span className="text-[12px] text-ink-faint">
            No email accounts connected in Smartlead yet.
          </span>
        )}
        {smartleadAccounts?.map((a) => {
          const staged = staging.pendingSmartleadAdds.some((p) => p.address === a.fromEmail);
          const blocked = !a.isSmtpSuccess;
          return (
            <div
              key={a.id}
              className="flex items-center gap-3 border border-ink-rule rounded-[var(--radius-sm)] px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] text-ink-cream">{a.fromEmail}</span>
                <span className="ln-mono text-[11px] text-ink-muted">
                  {a.messagePerDay != null ? `${a.messagePerDay}/day` : "no cap"}
                  {a.warmupStatus
                    ? ` · warmup ${a.warmupStatus.toLowerCase()}${a.warmupReputation ? ` (${a.warmupReputation})` : ""}`
                    : ""}
                  {blocked ? " · SMTP broken — reconnect in Smartlead" : ""}
                </span>
              </div>
              <div className="ml-auto">
                {a.alreadyRegistered ? (
                  <span className="ln-mono text-[11px] text-ink-faint">in pool</span>
                ) : staged ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => staging.unstageSmartlead(a.fromEmail)}
                  >
                    Undo
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-7 px-2 text-[11px]"
                    disabled={blocked}
                    onClick={() =>
                      staging.stageSmartlead({
                        address: a.fromEmail,
                        label: a.fromName ?? "",
                        providerMessagePerDay: a.messagePerDay,
                      })
                    }
                  >
                    Add
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {staging.pendingSmartleadAdds.length > 0 && (
          <span className="text-[12px] text-ink-faint">
            {staging.pendingSmartleadAdds.length} Smartlead mailbox
            {staging.pendingSmartleadAdds.length === 1 ? "" : "es"} staged — applied on Save with
            the cold-start warm-up ramp (capped at Smartlead's own per-mailbox limit).
          </span>
        )}
      </div>

      {isLegacyPool && (
        <Field label="Provider" className="mt-3">
          <Select
            value={draft.values.emailProvider}
            onChange={(e) => draft.set("emailProvider", e.target.value as "oneshot" | "gmail")}
          >
            <option value="oneshot">OneShot SDK (wallet-owned sending domain)</option>
            <option value="gmail">Gmail / Google Workspace (your own account)</option>
          </Select>
        </Field>
      )}
      {isLegacyPool && draft.values.emailProvider === "gmail" && (
        <div className="ln-note text-[12px] text-ink-muted">
          Emails send from your authenticated Gmail address — the sending domain in Founder profile
          is ignored. Easiest path: run{" "}
          <code className="ln-mono text-[11.5px] text-ink-cream-2">bun run cli -- gmail auth</code>{" "}
          to authorize in the browser and fill all three Gmail values in <CredentialsLink />{" "}
          automatically.
        </div>
      )}
    </SectionShell>
  );
}

function IdentityRow({
  identity: i,
  capValue,
  capError,
  onCap,
  onRemove,
}: {
  identity: SenderIdentityView;
  capValue: string;
  capError: string | undefined;
  onCap: (raw: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border border-ink-rule rounded-[var(--radius-sm)] px-3 py-2">
      <Badge
        tone={i.provider === "gmail" ? "signal" : i.provider === "smartlead" ? "spend" : "receipt"}
        className="mt-1.5"
      >
        {i.provider}
      </Badge>
      <div className="flex min-w-0 flex-col pt-1">
        <span className="truncate text-[13px] text-ink-cream">
          {i.mailbox && i.sendingDomain
            ? `${i.mailbox}@${i.sendingDomain}`
            : (i.address ?? i.sendingDomain ?? i.label ?? i.id)}
        </span>
        <span className="ln-mono text-[11px] text-ink-muted">
          {i.domainSentToday !== i.sentToday
            ? `today ${i.sentToday} · domain ${i.domainSentToday}/${i.capToday ?? "∞"} shared`
            : `today ${i.sentToday}/${i.capToday ?? "∞"}`}
          {i.warmup ? ` · warm-up ${i.warmup.startPerDay}+${i.warmup.incrementPerWeek}/wk` : ""}
          {i.legacy ? " · legacy (auto-derived)" : ""}
        </span>
      </div>
      <div className="ml-auto flex items-start gap-2">
        <Field label="max/day" error={capError} className="w-28 gap-0.5">
          <Input
            className="h-7 text-[12px]"
            placeholder="∞ (no cap)"
            inputMode="numeric"
            value={capValue}
            onChange={(e) => onCap(e.target.value)}
            aria-label={`max sends per day for ${i.id}`}
          />
        </Field>
        {!i.legacy && (
          <Button
            type="button"
            variant="secondary"
            className="mt-[18px] h-7 px-2 text-[11px]"
            onClick={onRemove}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

/** Provisioned OneShot domains — a paused domain sends nothing until resumed. */
function ProvisionedDomains({
  domains,
  busyDomain,
  onToggle,
}: {
  domains: DomainPoolView[];
  busyDomain: string | undefined;
  onToggle: (domain: string, action: "resume" | "pause") => void;
}) {
  if (domains.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-ink-rule pt-3">
      <span className="ln-eyebrow">Provisioned domains</span>
      {domains.map((d) => {
        const paused = d.poolStatus === "paused" || d.poolStatus === "removed";
        const tone =
          d.poolStatus === "active" ? "receipt" : d.poolStatus === "warming" ? "spend" : "blocked";
        const busy = busyDomain === d.domain;
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
              onClick={() => onToggle(d.domain, paused ? "resume" : "pause")}
              {...readOnly}
            >
              {busy ? "…" : paused ? "Resume" : "Pause"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Add OneShot sender — domain + mailbox join the rotation pool on Save. */
function AddOneShotSender({
  identities,
  provisionedDomains,
  founderLocalpart,
  pending,
  pendingErrors,
  onStage,
  onUnstage,
}: {
  identities: SenderIdentityView[];
  provisionedDomains: DomainPoolView[];
  founderLocalpart: string;
  pending: PendingOneShotAdd[];
  pendingErrors: Record<string, string>;
  onStage: (a: PendingOneShotAdd) => void;
  onUnstage: (a: PendingOneShotAdd) => void;
}) {
  const [addDomain, setAddDomain] = useState("");
  const [addMailbox, setAddMailbox] = useState("");
  const [addCap, setAddCap] = useState("");
  // Validated at Add time so a bad cap never even reaches the staged list.
  const capParsed = parseCap(addCap, { blank: "omit" });
  const capError = addCap.trim() && !capParsed.ok ? capParsed.error : null;
  const domain = addDomain.trim().toLowerCase();
  const stage = (): void => {
    if (!domain || !capParsed.ok) return;
    onStage({ sendingDomain: domain, mailbox: addMailbox, maxPerDay: addCap });
    setAddDomain("");
    setAddMailbox("");
    setAddCap("");
  };
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-ink-rule pt-3">
      <span className="ln-eyebrow">Add OneShot sender</span>
      {pending.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {pending.map((a) => {
            const key = `${a.mailbox.trim() || "agent"}@${a.sendingDomain}`;
            return (
              <div
                key={key}
                className="flex items-center gap-3 border border-dashed border-ink-rule rounded-[var(--radius-sm)] px-3 py-1.5"
              >
                <Badge tone="receipt">oneshot</Badge>
                <span className="truncate text-[13px] text-ink-cream">{key}</span>
                <span className="ln-mono text-[11px] text-ink-muted">
                  {a.maxPerDay.trim() ? `cap ${a.maxPerDay.trim()}/day` : "warm-up ramp"}
                </span>
                {pendingErrors[key] && (
                  <span className="font-mono text-[11px] text-[color:var(--ink-blocked-2)]">
                    {pendingErrors[key]}
                  </span>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  className="ml-auto h-7 px-2 text-[11px]"
                  onClick={() => onUnstage(a)}
                >
                  Remove
                </Button>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Domain" className="min-w-[200px]">
          {/* Pick a warmed domain or type a new one (auto-provisions on first send). */}
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
        <Field label="Max/day" className="w-28" error={capError}>
          <Input
            placeholder="ramp"
            inputMode="numeric"
            value={addCap}
            onChange={(e) => setAddCap(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                stage();
              }
            }}
            aria-label="max sends per day"
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          className="mb-[2px]"
          disabled={!domain || !capParsed.ok}
          onClick={stage}
        >
          Add
        </Button>
      </div>
      {/* A domain outside the warmed pool goes out cold — pinned sends bypass warm-up. */}
      {domain &&
        provisionedDomains.length > 0 &&
        !provisionedDomains.some((d) => d.domain.toLowerCase() === domain) && (
          <span className="text-[12px] text-ink-blocked">
            {domain} isn't in your warmed pool — it auto-provisions on first send and goes out cold
            (server warm-up is bypassed for chosen domains). The client ramp below is your only
            throttle.
          </span>
        )}
      {/* Reputation + send limits are per-domain, not per-mailbox. */}
      {domain && identities.some((i) => i.sendingDomain?.toLowerCase() === domain) && (
        <span className="text-[12px] text-ink-faint">
          Heads up: {domain} already sends in your pool. Reputation and the platform daily limit are
          per-domain — extra mailboxes share them, and their client caps stack on the same domain.
        </span>
      )}
      <span className="text-[12px] text-ink-faint">
        Blank mailbox defaults to your first name; blank cap uses the cold-start warm-up ramp
        (10/day, +10/week, max 50). Domains you send from are pinned, so the client ramp — not the
        server — paces warm-up. New senders join the pool on Save.
      </span>
    </div>
  );
}
