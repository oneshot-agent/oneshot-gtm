import { describe, expect, it } from "vitest";
import {
  activationHint,
  LAUNCHD_LABEL,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveServicePaths,
  serviceWritePath,
  SYSTEMD_UNIT,
} from "../src/commands/install-service.ts";

// Fixed fake paths: snapshots must not depend on the machine running the
// suite. These tests only render strings — they NEVER touch launchctl,
// systemctl, or any real service path.
const PATHS = {
  bunBin: "/opt/homebrew/bin/bun",
  cliEntry: "/Users/jo/oneshot-gtm/apps/cli/src/main.ts",
  home: "/Users/jo/.oneshot-gtm",
};

describe("renderLaunchdPlist", () => {
  it("matches the template snapshot", () => {
    expect(renderLaunchdPlist(PATHS)).toMatchSnapshot();
  });

  it("embeds every path absolute and unquoted (launchd execs the argv vector, no shell)", () => {
    const plist = renderLaunchdPlist(PATHS);
    expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>");
    expect(plist).toContain("<string>/Users/jo/oneshot-gtm/apps/cli/src/main.ts</string>");
    expect(plist).toContain("<string>/Users/jo/.oneshot-gtm</string>");
    // PATH must carry bun's own dir — launchd doesn't source a login shell.
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
  });

  it("XML-escapes paths so a checkout named e.g. `a&b` still yields a valid plist", () => {
    const plist = renderLaunchdPlist({ ...PATHS, home: "/Users/jo/a&b/<gtm>" });
    expect(plist).toContain("<string>/Users/jo/a&amp;b/&lt;gtm&gt;</string>");
    expect(plist).not.toContain("<gtm>");
  });
});

describe("renderSystemdUnit", () => {
  it("matches the template snapshot", () => {
    expect(renderSystemdUnit(PATHS)).toMatchSnapshot();
  });

  it("quotes ExecStart arguments and the environment so paths with spaces survive", () => {
    const unit = renderSystemdUnit({
      ...PATHS,
      bunBin: "/home/jo/my tools/bun",
      home: "/home/jo/gtm home",
    });
    expect(unit).toContain(
      'ExecStart="/home/jo/my tools/bun" "/Users/jo/oneshot-gtm/apps/cli/src/main.ts" find watch --quiet',
    );
    expect(unit).toContain('Environment="ONESHOT_GTM_HOME=/home/jo/gtm home"');
  });
});

describe("serviceWritePath", () => {
  it("targets ~/Library/LaunchAgents on macOS and ~/.config/systemd/user on Linux", () => {
    expect(serviceWritePath("darwin", "/Users/jo")).toBe(
      `/Users/jo/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    );
    expect(serviceWritePath("linux", "/home/jo")).toBe(
      `/home/jo/.config/systemd/user/${SYSTEMD_UNIT}`,
    );
  });

  it("has no target on Windows (Task Scheduler route is docs-only)", () => {
    expect(serviceWritePath("win32", "C:\\Users\\jo")).toBeNull();
  });
});

describe("activationHint", () => {
  it("covers install and uninstall on both platforms", () => {
    const mac = activationHint("darwin", "/Users/jo/Library/LaunchAgents/x.plist").join("\n");
    expect(mac).toContain("launchctl load");
    expect(mac).toContain("launchctl unload");
    const linux = activationHint("linux", `/home/jo/.config/systemd/user/${SYSTEMD_UNIT}`).join(
      "\n",
    );
    expect(linux).toContain("systemctl --user enable --now");
    expect(linux).toContain("systemctl --user disable --now");
  });
});

describe("resolveServicePaths", () => {
  it("resolves absolute paths for bun, the CLI entry, and the home", () => {
    const p = resolveServicePaths();
    expect(p.bunBin.startsWith("/")).toBe(true);
    expect(p.cliEntry.endsWith("/apps/cli/src/main.ts")).toBe(true);
    expect(p.cliEntry.startsWith("/")).toBe(true);
    // Under vitest this is the throwaway temp home from vitest.setup.ts —
    // the point is that it's absolute and flows into the template verbatim.
    expect(p.home.startsWith("/")).toBe(true);
    expect(typeof p.home).toBe("string");
  });
});
