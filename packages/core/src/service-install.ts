import { execFile } from "node:child_process";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  renderLaunchdService,
  renderSystemdService,
  serviceWritePath,
  type ServiceSpec,
} from "./services.ts";

export type ServiceCommand = (command: string, args: string[]) => Promise<void>;
const exec = promisify(execFile);
const runCommand: ServiceCommand = async (command, args) => {
  await exec(command, args, { timeout: 10_000 });
};

/** A possibly loaded service must retain its registered home for recovery. */
export class ServiceRollbackError extends Error {}

/** Return false only when no usable user service manager is available. */
export async function installDashboardService(
  spec: ServiceSpec,
  opts: { platform?: NodeJS.Platform; userHome?: string; run?: ServiceCommand } = {},
): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCommand;
  const target = serviceWritePath(platform, opts.userHome ?? homedir(), spec);
  if (!target) return false;
  try {
    // Having systemctl on PATH does not mean a user bus is running (containers, SSH).
    if (platform === "darwin") await run("launchctl", ["list"]);
    else await run("systemctl", ["--user", "show-environment"]);
  } catch {
    return false;
  }

  const content = platform === "darwin" ? renderLaunchdService(spec) : renderSystemdService(spec);
  mkdirSync(dirname(target), { recursive: true });
  // Do not overwrite an orphaned or operator-managed service with the same name.
  try {
    writeFileSync(target, content, { flag: "wx", mode: 0o644 });
  } catch (err) {
    // `wx` creates the file before writing it. EEXIST means it was another
    // file, which stays; any other failure leaves a partial file of ours that
    // would block every retry with EEXIST.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") rmSync(target, { force: true });
    throw err;
  }
  let activationAttempted = false;
  try {
    if (platform === "darwin") {
      activationAttempted = true;
      await run("launchctl", ["load", target]);
    } else {
      await run("systemctl", ["--user", "daemon-reload"]);
      activationAttempted = true;
      await run("systemctl", ["--user", "enable", "--now", spec.systemdUnit]);
    }
  } catch (err) {
    try {
      if (activationAttempted) {
        if (platform === "darwin") await run("launchctl", ["unload", target]);
        else await run("systemctl", ["--user", "disable", "--now", spec.systemdUnit]);
      }
      unlinkSync(target);
      if (platform === "linux") await run("systemctl", ["--user", "daemon-reload"]);
    } catch (cleanup) {
      throw new ServiceRollbackError(
        `service activation failed: ${(err as Error).message}; cleanup failed: ${(cleanup as Error).message}`,
      );
    }
    throw err;
  }
  return true;
}
