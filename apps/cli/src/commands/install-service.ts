/**
 * `--install-service`: emit a service file that keeps a long-running command
 * alive in the background: a launchd user agent on macOS, a systemd user unit
 * on Linux. Two commands have one: `find watch` (the watch daemon) and `ui`
 * (the dashboard server). Pure templating over values resolved at generation
 * time (bun binary, entry file, ONESHOT_GTM_HOME, and for the dashboard the
 * workspace's name and port): service managers don't inherit a shell, so
 * nothing here may rely on $PATH or a login profile. Windows has no
 * user-service equivalent; the README covers the schtasks + `--once` route.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configDir,
  dashboardService,
  dashboardServiceNames,
  resolveDashboardServicePaths,
  renderLaunchdService,
  renderSystemdService,
  serviceWritePath as coreServiceWritePath,
  type ServiceNames,
  type ServiceSpec,
} from "@oneshot-gtm/core";

// Keep the CLI imports used by callers and its snapshot tests stable.
export {
  dashboardService,
  dashboardServiceNames,
  resolveDashboardServicePaths,
  renderLaunchdService,
  renderSystemdService,
};
export type { DashboardServicePaths, ServiceNames, ServiceSpec } from "@oneshot-gtm/core";
import { bail, c, note, ok } from "../output.ts";

export const LAUNCHD_LABEL = "com.oneshot-gtm.find-watch";
export const SYSTEMD_UNIT = "oneshot-gtm-find-watch.service";

/** Every absolute path a service file embeds. Explicit so tests can pin them. */
export interface ServicePaths {
  /** Absolute path to the bun binary that will run the daemon. */
  bunBin: string;
  /** Absolute path to the CLI entry (apps/cli/src/main.ts). */
  cliEntry: string;
  /** The workspace home the daemon is bound to (ONESHOT_GTM_HOME). */
  home: string;
}

const WATCH_NAMES: ServiceNames = { launchdLabel: LAUNCHD_LABEL, systemdUnit: SYSTEMD_UNIT };

export function serviceWritePath(
  platform: NodeJS.Platform,
  userHome: string,
  names = WATCH_NAMES,
): string | null {
  return coreServiceWritePath(platform, userHome, names);
}

export function resolveServicePaths(): ServicePaths {
  return {
    bunBin: process.execPath,
    cliEntry: fileURLToPath(new URL("../main.ts", import.meta.url)),
    home: configDir(),
  };
}

function watchService(p: ServicePaths): ServiceSpec {
  return {
    ...WATCH_NAMES,
    description: "oneshot-gtm find watch — poll registered triggers and enqueue candidates",
    bunBin: p.bunBin,
    entry: p.cliEntry,
    args: ["find", "watch", "--quiet"],
    env: [["ONESHOT_GTM_HOME", p.home]],
    logPath: join(p.home, "find-watch.log"),
  };
}

/** The watch daemon's launchd agent. */
export function renderLaunchdPlist(p: ServicePaths): string {
  return renderLaunchdService(watchService(p));
}

/** The watch daemon's systemd user unit. */
export function renderSystemdUnit(p: ServicePaths): string {
  return renderSystemdService(watchService(p));
}

/**
 * Post-install commands, shown after `--write` (and in the README). The file
 * path is shell-quoted where it needs it: these lines are meant to be pasted.
 * A service manager reads the file once, when it loads it, so re-running
 * `--write` on a service that is already loaded needs the reload line too.
 */
export function activationHint(
  platform: NodeJS.Platform,
  writePath: string,
  names: ServiceNames = WATCH_NAMES,
): string[] {
  const file = shellQuoted(writePath);
  if (platform === "darwin") {
    return [
      `launchctl load ${file}`,
      `# already loaded, file rewritten: launchctl unload ${file} && launchctl load ${file}`,
      `# uninstall: launchctl unload ${file} && rm ${file}`,
    ];
  }
  return [
    "systemctl --user daemon-reload",
    `systemctl --user enable --now ${names.systemdUnit}`,
    `# already enabled, file rewritten: systemctl --user daemon-reload && systemctl --user restart ${names.systemdUnit}`,
    `# uninstall: systemctl --user disable --now ${names.systemdUnit} && rm ${file}`,
  ];
}

/**
 * How to make a running service pick up new code. The service file embeds
 * paths, not a version, so pulling and rebuilding changes nothing until the
 * process is restarted.
 */
export function restartHint(platform: NodeJS.Platform, names: ServiceNames): string {
  return platform === "darwin"
    ? `launchctl kickstart -k gui/$(id -u)/${names.launchdLabel}`
    : `systemctl --user restart ${names.systemdUnit}`;
}

function supportedPlatform(): "darwin" | "linux" {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    bail(
      `no service template for platform "${platform}". On Windows, schedule \`find watch --once\` ` +
        "with Task Scheduler; the recipe is in docs/background-monitoring.md.",
    );
  }
  return platform;
}

/** Print the service file, or with `--write` put it where the service manager looks. */
function emitService(
  platform: "darwin" | "linux",
  spec: ServiceSpec,
  opts: { write: boolean; extraHints?: string[]; closingNote: string },
): void {
  const content = platform === "darwin" ? renderLaunchdService(spec) : renderSystemdService(spec);
  const target = serviceWritePath(platform, homedir(), spec);
  if (!target) bail(`no conventional service path for platform "${platform}"`);
  const hints = [...activationHint(platform, target, spec), ...(opts.extraHints ?? [])];

  if (!opts.write) {
    // Template only on stdout so `> file` redirection stays clean; the
    // human-facing hints go to stderr.
    process.stdout.write(content);
    process.stderr.write(
      `\n${c.dim(`Write it to the conventional path with --write (${target}), then:`)}\n` +
        hints.map((l) => c.dim(`  ${l}`)).join("\n") +
        "\n",
    );
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: 0o644 });
  ok(`wrote ${target}`);
  note("Activate it with:");
  for (const line of hints) note(`  ${line}`);
  note(opts.closingNote);
}

export async function commandInstallService(opts: { write: boolean }): Promise<void> {
  const platform = supportedPlatform();
  emitService(platform, watchService(resolveServicePaths()), {
    write: opts.write,
    closingNote:
      "Paths are embedded absolute — re-run --install-service --write after moving bun or the checkout.",
  });
}

/**
 * `ui --install-service`: the dashboard as a login service, so it is back
 * after a reboot without anyone starting it. One service per workspace.
 */
export async function commandInstallDashboardService(opts: {
  write: boolean;
  port?: number;
}): Promise<void> {
  const platform = supportedPlatform();
  const paths = resolveDashboardServicePaths(opts.port);
  // The service serves the prebuilt dashboard; without it every page 404s.
  const webDist = fileURLToPath(new URL("../../../web/dist/index.html", import.meta.url));
  if (!existsSync(webDist)) {
    bail(
      `web build not found at ${webDist}. Run: bun run --cwd apps/web build (one-time), then re-run.`,
    );
  }
  const spec = dashboardService(paths);
  emitService(platform, spec, {
    write: opts.write,
    extraHints: [`# after pulling new code and rebuilding: ${restartHint(platform, spec)}`],
    closingNote:
      "Paths, workspace and port are embedded — re-run ui --install-service --write after moving bun or the checkout, or changing the port.",
  });
}

/** A path as one shell word: left bare when it is plain, single-quoted otherwise. */
function shellQuoted(path: string): string {
  if (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}
