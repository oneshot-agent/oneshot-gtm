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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_PORT, configDir, currentWorkspaceName, portForHome } from "@oneshot-gtm/core";
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

/** What the dashboard's service file embeds, all resolved from the active workspace. */
export interface DashboardServicePaths {
  /** Absolute path to the bun binary that will run the server. */
  bunBin: string;
  /** Absolute path to the server entry (apps/server/src/bin.ts). */
  serverEntry: string;
  /** The workspace home the server is bound to (ONESHOT_GTM_HOME). */
  home: string;
  /** The workspace's name; `default` for an install without named workspaces. */
  workspace: string;
  /** The port the dashboard listens on. */
  port: number;
}

/** The two names a service goes by: its launchd label and its systemd unit. */
export interface ServiceNames {
  launchdLabel: string;
  systemdUnit: string;
}

/** One background service, described once for both service managers. */
export interface ServiceSpec extends ServiceNames {
  /** systemd's one-line description. */
  description: string;
  bunBin: string;
  /** Absolute path of the file bun runs. */
  entry: string;
  /** Plain words after the entry; never paths, so they need no quoting. */
  args: string[];
  /** Environment in the order it is written. PATH is added by the renderers. */
  env: Array<[name: string, value: string]>;
  /** Where launchd sends stdout and stderr. systemd uses the user journal. */
  logPath: string;
}

const WATCH_NAMES: ServiceNames = { launchdLabel: LAUNCHD_LABEL, systemdUnit: SYSTEMD_UNIT };

export function resolveServicePaths(): ServicePaths {
  return {
    bunBin: process.execPath,
    cliEntry: fileURLToPath(new URL("../main.ts", import.meta.url)),
    home: configDir(),
  };
}

/**
 * The dashboard's values for the workspace this process is bound to. The port
 * is the workspace's registered one unless `--port` names another, the same
 * rule `ui` follows when it starts the server in the foreground.
 */
export function resolveDashboardServicePaths(port?: number): DashboardServicePaths {
  const home = configDir();
  let resolvedPort = port;
  if (resolvedPort == null) {
    try {
      resolvedPort = portForHome(home);
    } catch {
      // A corrupt registry is doctor's problem; `ui` falls back the same way.
      resolvedPort = BASE_PORT;
    }
  }
  return {
    bunBin: process.execPath,
    serverEntry: fileURLToPath(new URL("../../../server/src/bin.ts", import.meta.url)),
    home,
    workspace: currentWorkspaceName(),
    port: resolvedPort,
  };
}

/**
 * Service names for a workspace's dashboard. The workspace is part of the
 * name because dashboards run side by side, one per workspace. A registered
 * name is already `[a-z0-9-]` and is used as it is. Anything else (an
 * unregistered ONESHOT_GTM_HOME, which the CLI names `home:<path>`, or a
 * hand-set ONESHOT_GTM_WORKSPACE) is folded to that from the home folder's own
 * name, with a short hash of the original so two such installs never share a
 * service.
 */
export function dashboardServiceNames(workspace: string): ServiceNames {
  const readable = workspace.startsWith("home:") ? basename(workspace.slice(5)) : workspace;
  const folded =
    readable
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .join("-")
      .slice(0, 32) || "default";
  const slug =
    folded === workspace
      ? folded
      : `${folded}-${createHash("sha256").update(workspace).digest("hex").slice(0, 8)}`;
  return {
    launchdLabel: `com.oneshot-gtm.workspace.${slug}`,
    systemdUnit: `oneshot-gtm-workspace-${slug}.service`,
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

/**
 * The dashboard server, started the way one workspace starts another: the
 * server entry directly, bound by environment to a home, a name and a port.
 * ONESHOT_GTM_NO_BROWSER keeps a login from opening a browser tab.
 */
export function dashboardService(p: DashboardServicePaths): ServiceSpec {
  return {
    ...dashboardServiceNames(p.workspace),
    description: `oneshot-gtm dashboard — workspace ${p.workspace} on port ${p.port}`,
    bunBin: p.bunBin,
    entry: p.serverEntry,
    args: [],
    env: [
      ["ONESHOT_GTM_HOME", p.home],
      ["ONESHOT_GTM_WORKSPACE", p.workspace],
      ["PORT", String(p.port)],
      ["ONESHOT_GTM_NO_BROWSER", "1"],
    ],
    logPath: join(p.home, "dashboard.log"),
  };
}

/**
 * launchd runs the ProgramArguments vector directly (no shell), so every path
 * is a separate <string> and needs XML escaping only. Never shell quoting.
 * KeepAlive.SuccessfulExit=false restarts crashes but respects a clean
 * SIGTERM shutdown; logs land in the workspace home next to events.jsonl.
 */
export function renderLaunchdService(s: ServiceSpec): string {
  const argv = [s.bunBin, s.entry, ...s.args].map((a) => `    <string>${xml(a)}</string>`);
  const env = [...s.env, ["PATH", `${dirname(s.bunBin)}:/usr/bin:/bin`] as const].map(
    ([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(s.launchdLabel)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env.join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(s.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(s.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * systemd user unit. ExecStart paths are double-quoted so a home or checkout
 * path with spaces survives systemd's own word splitting, and escaped so the
 * characters systemd reads inside a quoted field stay literal; stdout and
 * stderr go to the user journal (`journalctl --user -u <unit>`).
 */
export function renderSystemdService(s: ServiceSpec): string {
  const exec = [
    `"${systemdQuoted(s.bunBin, "exec")}"`,
    `"${systemdQuoted(s.entry, "exec")}"`,
    ...s.args,
  ].join(" ");
  const env = [
    ...s.env,
    ["PATH", `${dirname(s.bunBin)}:/usr/local/bin:/usr/bin:/bin`] as const,
  ].map(([name, value]) => `Environment="${name}=${systemdQuoted(value, "env")}"`);
  return `[Unit]
Description=${s.description}
After=network-online.target

[Service]
Type=simple
ExecStart=${exec}
${env.join("\n")}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

/** The watch daemon's launchd agent. */
export function renderLaunchdPlist(p: ServicePaths): string {
  return renderLaunchdService(watchService(p));
}

/** The watch daemon's systemd user unit. */
export function renderSystemdUnit(p: ServicePaths): string {
  return renderSystemdService(watchService(p));
}

/** Platform-conventional install path for `--write`, per-user (no root). */
export function serviceWritePath(
  platform: NodeJS.Platform,
  userHome: string,
  names: ServiceNames = WATCH_NAMES,
): string | null {
  if (platform === "darwin")
    return join(userHome, "Library", "LaunchAgents", `${names.launchdLabel}.plist`);
  if (platform === "linux") return join(userHome, ".config", "systemd", "user", names.systemdUnit);
  return null;
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

/**
 * A value inside a double-quoted systemd field. Backslash and the quote are
 * escapes there, `%` starts a specifier everywhere in a unit file, and
 * ExecStart also expands `$NAME`. A line break would start a new directive,
 * which no escape prevents, so such a value is refused.
 */
function systemdQuoted(value: string, field: "exec" | "env"): string {
  if (/[\r\n]/.test(value)) {
    bail("a path or value with a line break cannot be written into a systemd unit");
  }
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return field === "exec" ? escaped.replaceAll("$", "$$$$") : escaped;
}

/** A path as one shell word: left bare when it is plain, single-quoted otherwise. */
function shellQuoted(path: string): string {
  if (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function xml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
