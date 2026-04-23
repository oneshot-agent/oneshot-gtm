import { advanceCadence, receiptUrlsForCadence } from "@oneshot-gtm/plays";
import { getLedger } from "@oneshot-gtm/core";
import { c, fail, header, note, ok, warn } from "../output.ts";

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

export function commandCadenceList(opts: { all: boolean }): void {
  header(`cadence list ${opts.all ? c.dim("(all)") : c.dim("(active only)")}`);
  const ledger = getLedger();
  const rows = opts.all ? ledger.listAllCadences() : ledger.listActiveCadences();
  if (rows.length === 0) {
    note("No cadences yet. Run a play to enroll prospects.");
    return;
  }
  for (const r of rows) {
    const status =
      r.status === "active"
        ? c.green(r.status)
        : r.status === "replied"
          ? c.cyan(r.status)
          : r.status === "breakup"
            ? c.yellow(r.status)
            : c.dim(r.status);
    process.stdout.write(
      `  ${status.padEnd(20)} ${c.cyan((r.prospect_email ?? "?").padEnd(36))} ${r.play_name.padEnd(20)} step=${r.current_step} ${c.dim("next:")}${r.next_due_at ?? "—"}\n`,
    );
  }
  process.stdout.write("\n");
}

export function commandCadenceStop(args: { email: string; play?: string }): void {
  header("cadence stop");
  const ledger = getLedger();
  const prospect = ledger.findProspectByEmail(args.email);
  if (!prospect) {
    fail(`prospect not found: ${args.email}`);
    process.exit(1);
  }
  const cadences = ledger
    .listAllCadences()
    .filter((c) => c.prospect_id === prospect.id && (!args.play || c.play_name === args.play));
  if (cadences.length === 0) {
    warn(`no cadences found for ${args.email}${args.play ? ` (play: ${args.play})` : ""}`);
    return;
  }
  for (const cad of cadences) {
    if (cad.status !== "active") continue;
    ledger.setCadenceStatus({
      prospectId: prospect.id,
      playName: cad.play_name,
      status: "completed",
    });
    ok(`stopped: ${cad.play_name} → ${args.email}`);
  }
}
