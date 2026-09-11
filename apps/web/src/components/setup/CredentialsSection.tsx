import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { XEngine } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { timeAgo } from "../../lib/cn.ts";
import { Badge } from "../primitives/Badge.tsx";
import { Button } from "../primitives/Button.tsx";
import { Field, Input } from "../primitives/Field.tsx";
import {
  CDP_KEYS,
  hintFor,
  LLM_KEY,
  SECRET_LABELS,
  walletKeysInUse,
  X_OAUTH_KEYS,
  type SecretKey,
} from "./constants.ts";
import { SectionShell } from "./SectionShell.tsx";
import { useSectionDraft } from "./useSectionDraft.ts";
import { useSectionSave } from "./useSectionSave.ts";
import { useReportDirty, type SectionProps } from "./types.ts";

type Secrets = Record<SecretKey, string>;

/**
 * The badge next to a key. "in use" means the runtime reads THIS key today
 * (selected by the saved preferences AND present). A selected key that is
 * missing is "needed" when core can't run without it, "optional" otherwise —
 * never "in use", which read as a contradiction next to an empty field.
 */
function keyState(
  g: Pick<Group, "inUse" | "optional">,
  k: SecretKey,
  isSet: boolean,
): { label: string; tone: "receipt" | "spend" | "neutral" } {
  if (!g.inUse(k)) return { label: isSet ? "set · not in use" : "not in use", tone: "neutral" };
  if (isSet) return { label: "in use", tone: "receipt" };
  return g.optional ? { label: "optional", tone: "neutral" } : { label: "needed", tone: "spend" };
}

/** Every secret starts blank on screen — the server never echoes a value. */
const EMPTY: Secrets = Object.fromEntries(
  (Object.keys(SECRET_LABELS) as SecretKey[]).map((k) => [k, ""]),
) as Secrets;

interface Group {
  title: string;
  caption?: string;
  keys: readonly SecretKey[];
  /** Keys the runtime routes through given the saved preferences (and what is set). */
  inUse: (k: SecretKey) => boolean;
  /**
   * Nothing core needs stops working without these (a finder, a channel, an
   * integration). A missing key is "optional", not "needed".
   */
  optional?: boolean;
  /** Extra hint for one key (e.g. the legacy-only refresh token). */
  keyHint?: Partial<Record<SecretKey, string>>;
  placeholder?: Partial<Record<SecretKey, string>>;
  /** One line of runtime state under the caption (a session's health, say). */
  status?: string;
  /** A side action for the group (connect a session), rendered under the status line. */
  action?: {
    label: string;
    pendingLabel: string;
    disabled: boolean;
    pending: boolean;
    error: string | null;
    onClick: () => void;
  };
}

/**
 * What the LinkedIn card says about the session. The cookie itself is never
 * echoed; the four states come from the setup status the server sends.
 */
export function linkedinSessionStatus(
  cfg: Pick<
    SectionProps["cfg"],
    "linkedinSessionCheckedAt" | "linkedinSessionName" | "linkedinSessionInvalidAt"
  >,
  cookieSet: boolean,
): string {
  if (!cookieSet) return "not connected";
  if (cfg.linkedinSessionInvalidAt) return "session expired — paste a fresh cookie";
  if (!cfg.linkedinSessionCheckedAt) return "cookie stored, session not checked yet";
  const who = cfg.linkedinSessionName ? `logged in as ${cfg.linkedinSessionName}` : "logged in";
  return `${who} · checked ${timeAgo(cfg.linkedinSessionCheckedAt)}`;
}

/**
 * Every `type="password"` input on the page, in one place (issue #451 scope
 * item 4). Preferences stay in their own sections; this one posts only
 * `{ secrets }`. A blank field means "keep what's there" — there is no
 * delete path for a secret from the web UI, same as before.
 */
export function CredentialsSection({
  cfg,
  sources,
  homeDir,
  isLegacyPool,
  xEngine,
  onDirtyChange,
  onSmartleadKeySaved,
}: SectionProps & {
  homeDir: string;
  isLegacyPool: boolean;
  xEngine: XEngine;
  /** A new Smartlead key = a different workspace; the email section drops its loaded list. */
  onSmartleadKeySaved: () => void;
}) {
  const draft = useSectionDraft(EMPTY);
  const save = useSectionSave<Partial<Secrets>>({
    save: async (sent) => {
      const secrets: Partial<Secrets> = {};
      for (const [k, v] of Object.entries(sent) as [SecretKey, string][]) {
        if (v.trim().length > 0) secrets[k] = v.trim();
      }
      await api.setup({ secrets });
    },
    refetch: [["setup"]],
    alsoInvalidate: [["doctor"], ["home"]],
    onCommitted: (sent) => {
      draft.commit(sent);
      if (sent.SMARTLEAD_API_KEY?.trim()) onSmartleadKeySaved();
    },
  });
  useReportDirty("credentials", draft.dirty, onDirtyChange);

  // Connect LinkedIn: one browser task that seeds the OneShot profile with
  // the stored cookie. The status line re-renders from the refetched cfg.
  const qc = useQueryClient();
  const [connectError, setConnectError] = useState<string | null>(null);
  const connectLinkedIn = useMutation({
    mutationFn: () => api.connectLinkedInSession(),
    onMutate: () => setConnectError(null),
    onSuccess: (r) => {
      if (!r.loggedIn)
        setConnectError(
          "LinkedIn did not treat the cookie as a signed-in session — paste a fresh li_at and try again.",
        );
      void qc.invalidateQueries({ queryKey: ["setup"] });
      void qc.invalidateQueries({ queryKey: ["doctor"] });
    },
    onError: (err: Error) => setConnectError(err.message),
  });
  const cookieSet = Boolean(sources.LINKEDIN_SESSION_COOKIE);
  const sessionChecked = Boolean(cfg.linkedinSessionCheckedAt);
  const connectPending = connectLinkedIn.isPending;

  const groups = useMemo<Group[]>(
    () => [
      {
        title: "LLM",
        caption: `Only the saved provider's key (${cfg.llmProvider}) is read.`,
        keys: ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
        inUse: (k) => k === LLM_KEY[cfg.llmProvider],
        placeholder: {
          OPENROUTER_API_KEY: "sk-or-...",
          OPENAI_API_KEY: "sk-...",
          ANTHROPIC_API_KEY: "sk-ant-...",
        },
      },
      {
        title: "Wallet",
        caption:
          "AGENT_PRIVATE_KEY wins when set, otherwise the three CDP keys. The wallet mode only drives the CLI wizard.",
        keys: [...CDP_KEYS, "AGENT_PRIVATE_KEY"],
        inUse: (k) => walletKeysInUse(sources).includes(k),
        placeholder: { AGENT_PRIVATE_KEY: "0x..." },
      },
      {
        title: "Gmail",
        caption:
          "Google Cloud OAuth client, Desktop type, Gmail API on. Needed for Connect Gmail account.",
        keys: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
        inUse: (k) =>
          k === "GMAIL_REFRESH_TOKEN" ? isLegacyPool && cfg.emailProvider === "gmail" : true,
        optional: true,
        keyHint: {
          GMAIL_REFRESH_TOKEN:
            "Legacy single-identity mode only; a pool stores tokens per identity.",
        },
      },
      {
        title: "Smartlead",
        caption: "Smartlead → Settings → API.",
        keys: ["SMARTLEAD_API_KEY"],
        inUse: () => true,
        optional: true,
      },
      {
        title: "X / Twitter",
        caption: `Follows the engine saved on the x-reposters trigger: ${xEngine === "xapi" ? "X API" : "twitterapi.io"}.`,
        keys: [...X_OAUTH_KEYS, "TWITTERAPI_IO_KEY"],
        inUse: (k) => (xEngine === "xapi") === (k !== "TWITTERAPI_IO_KEY"),
        optional: true,
      },
      {
        title: "LinkedIn replies",
        caption:
          "Lets a LinkedIn tool report a real reply so email cadences stop. Connection acceptance alone does nothing.",
        keys: ["LINKEDIN_REPLY_WEBHOOK_SECRET"],
        inUse: () => true,
        optional: true,
        keyHint: { LINKEDIN_REPLY_WEBHOOK_SECRET: "Random, 32+ characters." },
      },
      {
        title: "Finder access",
        caption: "Richer GitHub and Luma discovery.",
        keys: ["GITHUB_TOKEN", "LUMA_SESSION_COOKIE"],
        inUse: () => true,
        optional: true,
      },
      {
        title: "LinkedIn profile reads",
        caption:
          "Your li_at cookie (browser dev tools → Application → Cookies → linkedin.com). Person research then reads prospects' profiles live in a OneShot browser profile logged in as you; those reads show up to them as profile views from your account. Optional: without it, research uses the data provider's history.",
        keys: ["LINKEDIN_SESSION_COOKIE"],
        inUse: () => true,
        optional: true,
        status: linkedinSessionStatus(cfg, cookieSet),
        action: {
          label: sessionChecked ? "Reconnect" : "Connect",
          pendingLabel: "opening linkedin.com in a OneShot browser profile… ~1 min",
          disabled: !cookieSet,
          pending: connectPending,
          error: connectError,
          onClick: () => connectLinkedIn.mutate(),
        },
      },
    ],
    [
      cfg,
      sources,
      homeDir,
      isLegacyPool,
      xEngine,
      cookieSet,
      sessionChecked,
      connectPending,
      connectError,
      connectLinkedIn,
    ],
  );

  return (
    <SectionShell
      id="credentials"
      lede={`Every key and token. Saved to ${homeDir}/.env, chmod 600. Nothing leaves your machine; a blank field keeps the stored value.`}
      dirtyCount={draft.dirtyKeys.length}
      savedAt={save.savedAt}
      saving={save.isPending}
      onSubmit={() => save.run(draft.snapshot)}
      saveLabel="Save credentials"
    >
      <div className="flex flex-col gap-6">
        {groups.map((g) => (
          <fieldset key={g.title} className="flex flex-col gap-3 border-t border-ink-rule/60 pt-4">
            <legend className="ln-eyebrow float-left pr-2">{g.title}</legend>
            {g.caption && <p className="clear-both text-[12px] text-ink-faint">{g.caption}</p>}
            {g.status && (
              <p className="clear-both font-mono text-[11px] text-ink-muted">{g.status}</p>
            )}
            {g.action && (
              <div className="clear-both flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="receipt"
                  size="sm"
                  disabled={g.action.disabled || g.action.pending}
                  onClick={g.action.onClick}
                  title={g.action.disabled ? "Save the cookie first, then connect" : undefined}
                >
                  {g.action.pending ? g.action.pendingLabel : g.action.label}
                </Button>
                {g.action.error && (
                  <span className="text-[12px] text-[color:var(--ink-blocked-2)]">
                    {g.action.error}
                  </span>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {g.keys.map((k) => {
                const state = keyState(g, k, Boolean(sources[k]));
                const extra = g.keyHint?.[k];
                return (
                  <Field
                    key={k}
                    label={
                      <>
                        {SECRET_LABELS[k]}
                        <Badge tone={state.tone} className="ml-2 align-middle">
                          {state.label}
                        </Badge>
                      </>
                    }
                    hint={extra ? `${hintFor(sources[k])} ${extra}` : hintFor(sources[k])}
                  >
                    <Input
                      type="password"
                      placeholder={sources[k] ? "(unchanged)" : (g.placeholder?.[k] ?? "")}
                      value={draft.values[k]}
                      onChange={(e) => draft.set(k, e.target.value)}
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                  </Field>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </SectionShell>
  );
}
