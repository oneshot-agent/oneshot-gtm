/**
 * `find watch --install-service` — emit a service file that keeps the watch
 * daemon running in the background: a launchd user agent on macOS, a systemd
 * user unit on Linux. Pure templating over paths resolved at generation time
 * (bun binary, CLI entry, ONESHOT_GTM_HOME) — service managers don't inherit
 * a shell, so nothing here may rely on $PATH or a login profile. Windows has
 * no user-service equivalent; the README covers the schtasks + `--once` route.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "@oneshot-gtm/core";
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

export function resolveServicePaths(): ServicePaths {
  return {
    bunBin: process.execPath,
    cliEntry: fileURLToPath(new URL("../main.ts", import.meta.url)),
    home: configDir(),
  };
}

/**
 * launchd runs the ProgramArguments vector directly (no shell), so every path
 * is a separate <string> and needs XML escaping only — never shell quoting.
 * KeepAlive.SuccessfulExit=false restarts crashes but respects a clean
 * SIGTERM shutdown; logs land in the workspace home next to events.jsonl.
 */
export function renderLaunchdPlist(p: ServicePaths): string {
  const log = join(p.home, "find-watch.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.bunBin)}</string>
    <string>${xml(p.cliEntry)}</string>
    <string>find</string>
    <string>watch</string>
    <string>--quiet</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ONESHOT_GTM_HOME</key>
    <string>${xml(p.home)}</string>
    <key>PATH</key>
    <string>${xml(dirname(p.bunBin))}:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/**
 * systemd user unit. ExecStart arguments are double-quoted so a home or
 * checkout path with spaces survives systemd's own word splitting; stdout and
 * stderr go to the user journal (`journalctl --user -u oneshot-gtm-find-watch`).
 */
export function renderSystemdUnit(p: ServicePaths): string {
  return `[Unit]
Description=oneshot-gtm find watch — poll registered triggers and enqueue candidates
After=network-online.target

[Service]
Type=simple
ExecStart="${p.bunBin}" "${p.cliEntry}" find watch --quiet
Environment="ONESHOT_GTM_HOME=${p.home}"
Environment="PATH=${dirname(p.bunBin)}:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

/** Platform-conventional install path for `--write`, per-user (no root). */
export function serviceWritePath(platform: NodeJS.Platform, userHome: string): string | null {
  if (platform === "darwin")
    return join(userHome, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (platform === "linux") return join(userHome, ".config", "systemd", "user", SYSTEMD_UNIT);
  return null;
}

/** Post-install commands, shown after `--write` (and in the README). */
export function activationHint(platform: NodeJS.Platform, writePath: string): string[] {
  if (platform === "darwin") {
    return [
      `launchctl load ${writePath}`,
      `# uninstall: launchctl unload ${writePath} && rm ${writePath}`,
    ];
  }
  return [
    "systemctl --user daemon-reload",
    `systemctl --user enable --now ${SYSTEMD_UNIT}`,
    `# uninstall: systemctl --user disable --now ${SYSTEMD_UNIT} && rm ${writePath}`,
  ];
}

export async function commandInstallService(opts: { write: boolean }): Promise<void> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    bail(
      `no service template for platform "${platform}". On Windows, schedule \`find watch --once\` ` +
        "with Task Scheduler — see README § Background monitoring as a service.",
    );
  }
  const paths = resolveServicePaths();
  const content = platform === "darwin" ? renderLaunchdPlist(paths) : renderSystemdUnit(paths);
  const target = serviceWritePath(platform, homedir());
  if (!target) bail(`no conventional service path for platform "${platform}"`);

  if (!opts.write) {
    // Template only on stdout so `> file` redirection stays clean; the
    // human-facing hints go to stderr.
    process.stdout.write(content);
    process.stderr.write(
      `\n${c.dim(`Write it to the conventional path with --write (${target}), then:`)}\n` +
        activationHint(platform, target)
          .map((l) => c.dim(`  ${l}`))
          .join("\n") +
        "\n",
    );
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: 0o644 });
  ok(`wrote ${target}`);
  note("Activate it with:");
  for (const line of activationHint(platform, target)) note(`  ${line}`);
  note(
    "Paths are embedded absolute — re-run --install-service --write after moving bun or the checkout.",
  );
}

function xml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
