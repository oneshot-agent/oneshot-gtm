import { currentWorkspaceName, linkedInSdk } from "@oneshot-gtm/core";
import { advanceCadence, receiptUrls, reclassifyAutoReplies } from "@oneshot-gtm/plays";
import { c, header, note, ok } from "../output.ts";

/**
 * `cadence reclassify-auto --since 14d [--write]`: read the stored automatic
 * replies (and policy blocks) of the window again and print, per row, the
 * reason, return date, successor and the action. Dry run unless `--write`.
 */
export async function commandCadenceReclassifyAuto(opts: {
  since: number;
  write: boolean;
}): Promise<void> {
  header(`cadence reclassify-auto --since ${opts.since}d ${opts.write ? "" : c.dim("(dry-run)")}`);
  const sinceIso = new Date(Date.now() - opts.since * 86_400_000).toISOString();
  const rows = await reclassifyAutoReplies({ sinceIso, write: opts.write });
  if (rows.length === 0) {
    note("No automatic replies or policy blocks in the window.");
    return;
  }
  for (const r of rows) {
    const who = `${r.email}${r.company ? ` (${r.company})` : ""}`;
    const reason =
      r.reason === "left_company"
        ? c.yellow("left_company")
        : r.reason === "out_of_office"
          ? c.cyan("out_of_office")
          : r.reason === "blocked"
            ? c.yellow("blocked")
            : c.dim("other");
    const facts = [
      r.returnDate ? `back ${r.returnDate}` : null,
      r.successor
        ? `successor ${[r.successor.name, r.successor.email].filter(Boolean).join(" ")}${
            r.successorSkip ? ` (not queued: ${r.successorSkip})` : ""
          }`
        : null,
    ].filter(Boolean);
    process.stdout.write(
      `  ${r.receivedAt.slice(0, 10)}  ${reason.padEnd(24)} ${who}${
        facts.length ? c.dim(` · ${facts.join(" · ")}`) : ""
      }\n    ${c.dim("→")} ${r.action}\n`,
    );
  }
  process.stdout.write("\n");
  if (opts.write) ok(`done: ${rows.length} rows.`);
  else note(`${rows.length} rows. Nothing written; run again with --write to apply.`);
}

export async function commandCadenceAdvance(opts: { dryRun: boolean }): Promise<void> {
  header(`cadence advance ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  // The CLI calls OneShot only as its own workspace; LinkedIn steps for an
  // account owned by another workspace are sent from that dashboard.
  const result = await advanceCadence({
    dryRun: opts.dryRun,
    linkedIn: async (workspace, operation) => {
      if (workspace !== currentWorkspaceName()) {
        throw new Error(
          `LinkedIn account belongs to workspace ${workspace}; send from its dashboard`,
        );
      }
      return linkedInSdk(operation);
    },
  });

  process.stdout.write(
    `${c.dim("Polled:")} ${result.polled} inbound  ${c.dim("Replies:")} ${result.repliesDetected}  ${c.dim("Steps sent:")} ${result.stepsExecuted}  ${c.dim("Breakups:")} ${result.breakups}  ${c.dim("Completed:")} ${result.completed}\n\n`,
  );

  if (result.details.length === 0) {
    note("Nothing due. Try again later, or --dry-run to preview.");
    return;
  }

  for (const d of result.details) {
    const subject = `${d.playName} → ${d.prospectEmail ?? "(unknown)"}`;
    const action =
      d.action === "step-sent"
        ? c.green("step-sent")
        : d.action === "marked-replied"
          ? c.cyan("replied")
          : d.action === "breakup"
            ? c.yellow("breakup")
            : d.action === "completed"
              ? c.dim("completed")
              : d.action === "waiting"
                ? c.dim("waiting")
                : c.dim("skipped");
    process.stdout.write(
      `  ${action.padEnd(20)} ${subject}${d.note ? c.dim(" — " + d.note) : ""}\n`,
    );
    if (d.receiptIds.length > 0) {
      const urls = receiptUrls(d.receiptIds);
      process.stdout.write(`    ${c.dim("receipts:")} ${urls.map((u) => c.dim(u)).join(" ")}\n`);
    }
  }
  process.stdout.write("\n");
  ok(`done.`);
}
