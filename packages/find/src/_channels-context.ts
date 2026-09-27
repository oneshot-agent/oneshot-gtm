import { AsyncLocalStorage } from "node:async_hooks";
import { isOutreachChannel, loadConfig, type OutreachChannel } from "@oneshot-gtm/core";

/**
 * Which outreach channels the current finder run may use, in order of
 * preference. The first channel a candidate has an address on wins: with
 * `["email", "linkedin"]` a person without a deliverable email is queued on
 * LinkedIn instead of dropped; `["linkedin"]` never pays for an email lookup.
 *
 * Set per trigger run by the registry (the trigger's `channels` config) so the
 * shared contact step sees it without threading an option through every
 * finder. Outside a run: the workspace's `channels` config, then email only.
 */
const context = new AsyncLocalStorage<OutreachChannel[]>();

/** A config value as an ordered, de-duplicated channel list, or null when unusable. */
export function parseChannels(value: unknown): OutreachChannel[] | null {
  if (!Array.isArray(value)) return null;
  const out: OutreachChannel[] = [];
  for (const item of value) if (isOutreachChannel(item) && !out.includes(item)) out.push(item);
  return out.length > 0 ? out : null;
}

export function withFinderChannels<T>(channels: OutreachChannel[] | null, fn: () => T): T {
  return channels ? context.run(channels, fn) : fn();
}

export function finderChannels(): OutreachChannel[] {
  return context.getStore() ?? parseChannels(loadConfig().channels) ?? ["email"];
}
