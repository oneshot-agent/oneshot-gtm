import type { Command } from "commander";
import {
  getLedger,
  uploadMailArtwork,
  previewDirectMail,
  refreshDirectMail,
  approveDirectMail,
  cancelDirectMail,
} from "@oneshot-gtm/core";
import { sendDirectMailCadenceStep } from "@oneshot-gtm/plays";
export function registerDirectMailCommand(program: Command) {
  const cmd = program
    .command("direct-mail")
    .description("Review and approve individual physical mailpieces");
  cmd
    .command("list")
    .action(() => console.log(JSON.stringify(getLedger().listDirectMail(), null, 2)));
  cmd
    .command("upload <file>")
    .requiredOption("--mime <type>", "application/pdf, image/png, or image/jpeg")
    .action(async (file, opts) => {
      console.log(
        JSON.stringify(
          await uploadMailArtwork(new Uint8Array(await Bun.file(file).arrayBuffer()), opts.mime),
          null,
          2,
        ),
      );
    });
  cmd
    .command("preview <prospect-id> <play> <input-json>")
    .description(
      "Prepare a configured direct-mail cadence step; JSON contains to, from, artwork asset IDs",
    )
    .action(async (prospect, play, path) => {
      console.log(
        JSON.stringify(
          await previewDirectMail(Number(prospect), play, await Bun.file(path).json()),
          null,
          2,
        ),
      );
    });
  cmd
    .command("refresh <id>")
    .action(async (id) => console.log(JSON.stringify(await refreshDirectMail(id), null, 2)));
  cmd
    .command("approve <id>")
    .requiredOption("--input-hash <hash>", "Reviewed quote input hash")
    .requiredOption("--total-usdc <amount>", "Reviewed total price")
    .requiredOption("--approve", "Explicitly approve this mailpiece")
    .action(async (id, opts) => {
      console.log(
        JSON.stringify(
          await approveDirectMail(id, {
            input_hash: opts.inputHash,
            total_usdc: opts.totalUsdc,
            approved: opts.approve,
          }),
          null,
          2,
        ),
      );
    });
  cmd.command("send <id>").action(async (id) => {
    const draft = getLedger().getDirectMail(id);
    if (!draft) throw new Error("Mailpiece not found");
    console.log(JSON.stringify(await sendDirectMailCadenceStep(id), null, 2));
  });
  cmd
    .command("cancel <id>")
    .action(async (id) => console.log(JSON.stringify(await cancelDirectMail(id), null, 2)));
}
