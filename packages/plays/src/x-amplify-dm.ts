import { isRunCancelled, loadConfig, parallelMap, throwIfCancelled } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import { errorDraft, logTargetError } from "./_lib.ts";
import type { DraftedRow } from "./registry.ts";

/**
 * Amplifier-lane prospect with no findable email: the draft is X DM (or
 * reply-under-their-repost) text, hand-sent from the X app. This play NEVER
 * sends — `sent` is always false, so a drained row keeps its draft and stays
 * visible on /queue until the founder copies the text, sends it by hand, and
 * hits Mark sent (which records the channel:"x" sequence event).
 *
 * Automated X sending is deliberately absent: the dev app has no DM
 * permission, and cold DMs at volume are the fastest way to get an account
 * restricted.
 */
export interface XAmplifyDmTarget {
  name: string;
  /** X handle, without the @. */
  handle: string;
  twitterUrl: string;
  /** Numeric X user id — enables the DM compose deep-link in the queue UI. */
  xUserId?: string;
  /**
   * Whether their DMs are open. `engine` says which question was answered:
   * xapi's `receives_your_dm` is per-relationship truth, twitterapi.io's
   * `canDm` means "accepts DMs from anyone". Closed DMs → reply on the repost.
   */
  dmOpen?: boolean;
  engine?: string;
  /** The watched account they reposted. */
  seedHandle: string;
  tweetUrl: string;
  tweetText: string;
  mode: "retweet" | "quote";
  /** Their own words when they quoted — the best hook when present. */
  quote?: string | null;
  followers?: number;
  score?: number;
  why?: string;
  /** ISO launch date — the ONLY timing fact the draft may state. */
  launchDate?: string | null;
}

export interface XAmplifyDmRunOptions {
  dryRun: boolean;
  targets: XAmplifyDmTarget[];
  onProgress?: (index: number, draft: DraftedRow) => void;
  /** Abort signal for the run — see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
}

interface XAmplifyDmDraft extends DraftedRow {
  target: XAmplifyDmTarget;
}

const PLAY_NAME = "x-amplify-dm";

/**
 * Plays whose drafts are sent by hand outside oneshot-gtm. The server's
 * mark-sent route accepts only these; drain never flips their rows to sent.
 */
export const MANUAL_PLAYS: Record<string, { channel: "x" }> = {
  [PLAY_NAME]: { channel: "x" },
};

export async function runXAmplifyDm(
  opts: XAmplifyDmRunOptions,
): Promise<{ drafted: XAmplifyDmDraft[] }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const system = loadPrompt(PLAY_NAME);

  const drafted = await parallelMap(
    opts.targets,
    4,
    async (t): Promise<XAmplifyDmDraft> => {
      try {
        // Custom loop, so it repeats runEmailPlay's guard itself: the model
        // call below is this play's only paid step.
        throwIfCancelled(opts.signal, `${PLAY_NAME} draft`);
        const input = [
          `FOUNDER: ${cfg.founderName}`,
          `PRODUCT: ${cfg.productOneLiner}`,
          `PROSPECT: ${t.name} (@${t.handle} on X)`,
          `SEED: @${t.seedHandle}`,
          `THEY_REPOSTED: ${t.tweetText} (${t.tweetUrl})`,
          `MODE: ${t.mode}`,
          ...(t.quote ? [`THEIR_QUOTE: ${t.quote}`] : []),
          `DM_OPEN: ${t.dmOpen ? "yes — write a DM" : "no — write a reply to post under their repost"}`,
          ...(t.launchDate ? [`LAUNCH_DATE: ${t.launchDate}`] : []),
        ].join("\n");
        const res = await complete({
          messages: [
            { role: "system", content: system },
            { role: "user", content: input },
          ],
          temperature: 0.7,
          maxTokens: 300,
        });
        const body = res.content.trim();
        if (!body) throw new Error("empty draft from the model");
        return {
          target: t,
          subject: `X ${t.dmOpen ? "DM" : "reply"} → @${t.handle}`,
          body,
          flags: [],
          // Never true: this play has no transport. Drain persists the draft
          // and leaves the row pending for the hand-send + Mark sent flow.
          sent: false,
          receiptIds: [],
        };
      } catch (err) {
        // Cancellation is not a target failure — propagate so the run row
        // lands 'cancelled' instead of a batch of error drafts.
        if (isRunCancelled(err)) throw err;
        logTargetError({ playName: PLAY_NAME, err });
        return { target: t, ...errorDraft((err as Error)?.message) };
      }
    },
    opts.onProgress ? (_t, result, index) => opts.onProgress?.(index, result) : undefined,
  );

  return { drafted };
}
