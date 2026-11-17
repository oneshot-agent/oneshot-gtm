/** Service descriptions shared by the CLI and dashboard workspace creation. */
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./config.ts";
import { currentWorkspaceName } from "./shared-db.ts";
import { BASE_PORT, portForHome } from "./workspaces.ts";

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
  /** Bun flags before the script (dashboard creation suppresses repository .env loading). */
  runtimeArgs?: string[];
  /** Environment in the order it is written. PATH is added by the renderers. */
  env: Array<[name: string, value: string]>;
  /** Where launchd sends stdout and stderr. systemd uses the user journal. */
  logPath: string;
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
    serverEntry: dashboardServerEntry(),
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
  const argv = [s.bunBin, ...(s.runtimeArgs ?? []), s.entry, ...s.args].map(
    (a) => `    <string>${xml(a)}</string>`,
  );
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
    ...(s.runtimeArgs ?? []).map((arg) => `"${systemdQuoted(arg, "exec")}"`),
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

/** Platform-conventional install path for `--write`, per-user (no root). */
export function serviceWritePath(
  platform: NodeJS.Platform,
  userHome: string,
  names: ServiceNames,
): string | null {
  if (platform === "darwin")
    return join(userHome, "Library", "LaunchAgents", `${names.launchdLabel}.plist`);
  if (platform === "linux") return join(userHome, ".config", "systemd", "user", names.systemdUnit);
  return null;
}

/**
 * A value inside a double-quoted systemd field. Backslash and the quote are
 * escapes there, `%` starts a specifier everywhere in a unit file, and
 * ExecStart also expands `$NAME`. A line break would start a new directive,
 * which no escape prevents, so such a value is refused.
 */
function systemdQuoted(value: string, field: "exec" | "env"): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("a path or value with a line break cannot be written into a systemd unit");
  }
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return field === "exec" ? escaped.replaceAll("$", "$$$$") : escaped;
}

function xml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Source checkouts and the published server bundle both launch the same server entry. */
export function dashboardServerEntry(): string {
  const source = fileURLToPath(new URL("../../../apps/server/src/bin.ts", import.meta.url));
  return existsSync(source) ? source : fileURLToPath(new URL("./bin.mjs", import.meta.url));
}
