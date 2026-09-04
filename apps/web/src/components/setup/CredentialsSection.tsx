import { useMemo } from "react";
import type { XEngine } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { Badge } from "../primitives/Badge.tsx";
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

  const groups = useMemo<Group[]>(
    () => [
      {
        title: "LLM",
        caption: `The key for your saved provider (${cfg.llmProvider}) is the one in use.`,
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
        caption: `Keys live only in ${homeDir}/.env chmod 600. Nothing leaves your machine. The runtime uses AGENT_PRIVATE_KEY whenever it is set, otherwise the three CDP keys — the saved wallet mode only decides which ones the CLI wizard asks for.`,
        keys: [...CDP_KEYS, "AGENT_PRIVATE_KEY"],
        inUse: (k) => walletKeysInUse(sources).includes(k),
        placeholder: { AGENT_PRIVATE_KEY: "0x..." },
      },
      {
        title: "Gmail",
        caption:
          "Google Cloud OAuth client (Desktop type, Gmail API enabled). Needed before Connect Gmail account in Email transport.",
        keys: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
        inUse: (k) =>
          k === "GMAIL_REFRESH_TOKEN" ? isLegacyPool && cfg.emailProvider === "gmail" : true,
        optional: true,
        keyHint: {
          GMAIL_REFRESH_TOKEN:
            "Legacy single-identity Gmail mode only. With a rotation pool, Connect Gmail account stores tokens per identity instead.",
        },
      },
      {
        title: "Smartlead",
        caption: "Smartlead → Settings → API. Then load and pick mailboxes in Email transport.",
        keys: ["SMARTLEAD_API_KEY"],
        inUse: () => true,
        optional: true,
      },
      {
        title: "X / Twitter",
        caption: `Which set is used follows the engine saved on the x-reposters trigger (${xEngine === "xapi" ? "X API" : "twitterapi.io"}).`,
        keys: [...X_OAUTH_KEYS, "TWITTERAPI_IO_KEY"],
        inUse: (k) => (xEngine === "xapi") === (k !== "TWITTERAPI_IO_KEY"),
        optional: true,
      },
      {
        title: "LinkedIn replies",
        caption:
          "Lets LinkedIn automation tools report a real prospect reply so OneShot stops every live email cadence. Connection acceptance alone does nothing.",
        keys: ["LINKEDIN_REPLY_WEBHOOK_SECRET"],
        inUse: () => true,
        optional: true,
        keyHint: { LINKEDIN_REPLY_WEBHOOK_SECRET: "Use a random 32+ character bearer secret." },
      },
      {
        title: "Finder access",
        caption: "Optional credentials for richer GitHub and Luma discovery.",
        keys: ["GITHUB_TOKEN", "LUMA_SESSION_COOKIE"],
        inUse: () => true,
        optional: true,
      },
    ],
    [cfg.llmProvider, cfg.emailProvider, sources, homeDir, isLegacyPool, xEngine],
  );

  return (
    <SectionShell
      id="credentials"
      lede={`Every key and token, apart from the preferences that choose between them. Saved to ${homeDir}/.env (chmod 600); a blank field keeps the stored value.`}
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
