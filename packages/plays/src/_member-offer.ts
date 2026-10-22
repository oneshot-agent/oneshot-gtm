import { effectiveMemberOffer, getLedger, loadConfig } from "@oneshot-gtm/core";

const PLAY_NAME = "multiplier";

/**
 * The member offer a later touch of a multiplier cadence (the letter, the
 * follow-up email) proposes: the one the originating send made. That send's
 * queue row is the one the cadence started from (`cadenceQueueRow`: its
 * `queue_id`, else the newest `sent` row of the play for the address), and
 * its source names the trigger whose `memberOffer` applied to it; a newer
 * pending or rejected row from another trigger, with another offer or an
 * empty one, does not change the offer mid-cadence. A send from no queue row
 * (a manual run) proposed the workspace's offer. Trimmed; "" when neither the
 * trigger nor the workspace sets one.
 */
export function enrolledMemberOffer(
  prospectId: number | null | undefined,
  cfg: { memberOffer?: string | null } = loadConfig(),
  ledger: Pick<ReturnType<typeof getLedger>, "cadenceQueueRow" | "getTrigger"> = getLedger(),
): string {
  const source =
    prospectId != null ? (ledger.cadenceQueueRow(prospectId, PLAY_NAME)?.source ?? null) : null;
  return effectiveMemberOffer(cfg, source, (name) => ledger.getTrigger(name));
}
