import { advanceCadence, receiptUrlsForCadence } from "@oneshot-gtm/plays";
import { c, header, note, ok } from "../output.ts";

export async function commandCadenceAdvance(opts: { dryRun: boolean }): Promise<void> {
  header(`cadence advance ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const result = await advanceCadence({ dryRun: opts.dryRun });

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
      const urls = receiptUrlsForCadence(d.receiptIds);
      process.stdout.write(`    ${c.dim("receipts:")} ${urls.map((u) => c.dim(u)).join(" ")}\n`);
    }
  }
  process.stdout.write("\n");
  ok(`done.`);
}
