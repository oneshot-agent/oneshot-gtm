import {
  describeDoNotContact,
  doNotContactMatch,
  doNotContactOf,
  getLedger,
  loadConfig,
  queuePayloadIdentity,
  type QueueRow,
  type QueueStatus,
} from "@oneshot-gtm/core";
import { c, header, ok, warn } from "../output.ts";

/**
 * `find do-not-contact`: apply the workspace's `doNotContact` list to what is
 * already in flight. Unsent queue rows (pending or approved) at a listed
 * company are rejected as a machine drop, and active cadences with someone
 * there are stopped as do-not-contact. New rows, sends, invites and cadence
 * steps are gated as they happen; this catches what came before the entry.
 * `--dry-run` lists the matches and changes nothing.
 */
export interface DoNotContactOpts {
  dryRun: boolean;
}

export interface DoNotContactSummary {
  /** Queue rows rejected (dry run: would be), as `#id play: why`. */
  rows: string[];
  /** Cadences stopped (dry run: would be), as `name (play): why`. */
  cadences: string[];
}

const UNSENT: readonly QueueStatus[] = ["pending", "approved"];
const PAGE = 500;

function payloadOf(row: QueueRow): unknown {
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

export async function commandDoNotContact(opts: DoNotContactOpts): Promise<DoNotContactSummary> {
  header(`do-not-contact${opts.dryRun ? " --dry-run" : ""}`);
  const list = doNotContactOf(loadConfig());
  const summary: DoNotContactSummary = { rows: [], cadences: [] };
  if (list.domains.length === 0 && list.companies.length === 0) {
    warn("doNotContact is empty in this workspace's config.json: nothing to do");
    return summary;
  }
  const ledger = getLedger();

  for (const status of UNSENT) {
    const matches: Array<{ row: QueueRow; why: string }> = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = ledger.listQueue({ status, limit: PAGE, offset, dir: "asc" });
      for (const row of page) {
        const identity = queuePayloadIdentity(payloadOf(row));
        const prospect = row.prospect_id != null ? ledger.getProspectById(row.prospect_id) : null;
        const match = doNotContactMatch(
          {
            ...identity,
            email: [identity.email, prospect?.email].flat(),
            company: [identity.company, prospect?.company].flat(),
          },
          list,
        );
        if (match) matches.push({ row, why: describeDoNotContact(match) });
      }
      if (page.length < PAGE) break;
    }
    // Rejected after the scan, so the pages it read did not shift under it.
    for (const { row, why } of matches) {
      summary.rows.push(`#${row.id} ${row.play_name} (${status}): ${why}`);
      if (!opts.dryRun) {
        ledger.setQueueStatus({
          id: row.id,
          status: "rejected",
          notes: `auto: do-not-contact — ${why}`,
          decidedBy: "machine",
        });
      }
    }
  }

  for (const cad of ledger.listActiveCadences()) {
    const match = doNotContactMatch(
      { email: cad.prospect_email, company: cad.prospect_company },
      list,
    );
    if (!match) continue;
    const why = describeDoNotContact(match);
    const who = `${cad.prospect_name ?? `prospect ${cad.prospect_id}`} (${cad.play_name})`;
    // A step mid-send holds its marker; the step gate stops it before the next one.
    if (
      !opts.dryRun &&
      !ledger.stopCadence({
        prospectId: cad.prospect_id,
        playName: cad.play_name,
        reason: "do_not_contact",
        note: why,
      })
    ) {
      warn(`${who}: sending now, so not stopped here; its next step stops it`);
      continue;
    }
    summary.cadences.push(`${who}: ${why}`);
  }

  for (const line of summary.rows) console.log(`  ${c.dim("row")} ${line}`);
  for (const line of summary.cadences) console.log(`  ${c.dim("cadence")} ${line}`);
  const would = opts.dryRun ? "would be " : "";
  ok(
    `${summary.rows.length} queue row(s) ${would}rejected, ${summary.cadences.length} cadence(s) ${would}stopped`,
  );
  return summary;
}
