import { describe, expect, it } from "vitest";
import {
  activationHint,
  dashboardService,
  dashboardServiceNames,
  LAUNCHD_LABEL,
  renderLaunchdPlist,
  renderLaunchdService,
  renderSystemdService,
  renderSystemdUnit,
  resolveDashboardServicePaths,
  resolveServicePaths,
  restartHint,
  serviceWritePath,
  SYSTEMD_UNIT,
} from "../src/commands/install-service.ts";

// Fixed fake paths: snapshots must not depend on the machine running the
// suite. These tests only render strings. They NEVER touch launchctl,
// systemctl, or any real service path.
const PATHS = {
  bunBin: "/opt/homebrew/bin/bun",
  cliEntry: "/Users/jo/oneshot-gtm/apps/cli/src/main.ts",
  home: "/Users/jo/.oneshot-gtm",
};

const DASHBOARD = {
  bunBin: "/opt/homebrew/bin/bun",
  serverEntry: "/Users/jo/oneshot-gtm/apps/server/src/bin.ts",
  home: "/Users/jo/.oneshot-gtm-workspaces/acme",
  workspace: "acme",
  port: 3031,
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
    // PATH must carry bun's own dir: launchd doesn't source a login shell.
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
    // Under vitest this is the throwaway temp home from vitest.setup.ts:
    // the point is that it's absolute and flows into the template verbatim.
    expect(p.home.startsWith("/")).toBe(true);
    expect(typeof p.home).toBe("string");
  });
});

describe("dashboard service", () => {
  it("matches the launchd snapshot", () => {
    expect(renderLaunchdService(dashboardService(DASHBOARD))).toMatchSnapshot();
  });

  it("matches the systemd snapshot", () => {
    expect(renderSystemdService(dashboardService(DASHBOARD))).toMatchSnapshot();
  });

  it("is named after its workspace, so dashboards for several workspaces coexist", () => {
    expect(dashboardServiceNames("acme")).toEqual({
      launchdLabel: "com.oneshot-gtm.workspace.acme",
      systemdUnit: "oneshot-gtm-workspace-acme.service",
    });
    expect(dashboardServiceNames("default").launchdLabel).toBe("com.oneshot-gtm.workspace.default");
    expect(dashboardServiceNames("acme").launchdLabel).not.toBe(
      dashboardServiceNames("acme-eu").launchdLabel,
    );
  });

  it("folds a hand-set workspace name into a valid label and file name, kept unique by a hash", () => {
    expect(dashboardServiceNames("My Workspace/2").launchdLabel).toMatch(
      /^com\.oneshot-gtm\.workspace\.my-workspace-2-[0-9a-f]{8}$/,
    );
    expect(dashboardServiceNames("///").systemdUnit).toMatch(
      /^oneshot-gtm-workspace-default-[0-9a-f]{8}\.service$/,
    );
    // Folding must not make two different names collide.
    expect(dashboardServiceNames("My Workspace").launchdLabel).not.toBe(
      dashboardServiceNames("my-workspace").launchdLabel,
    );
  });

  it("names an unregistered home after its folder, not its whole path", () => {
    const a = dashboardServiceNames("home:/srv/installs/Acme GTM");
    expect(a.launchdLabel).toMatch(/^com\.oneshot-gtm\.workspace\.acme-gtm-[0-9a-f]{8}$/);
    // Same folder name elsewhere is a different install, so a different service.
    expect(dashboardServiceNames("home:/opt/other/Acme GTM").launchdLabel).not.toBe(a.launchdLabel);
    expect(dashboardServiceNames(`home:/x/${"y".repeat(80)}`).launchdLabel.length).toBeLessThan(70);
  });

  it("runs the server entry directly, bound to the workspace by environment", () => {
    const plist = renderLaunchdService(dashboardService(DASHBOARD));
    expect(plist).toContain("<string>/Users/jo/oneshot-gtm/apps/server/src/bin.ts</string>");
    expect(plist).toContain(
      "<key>ONESHOT_GTM_HOME</key>\n    <string>/Users/jo/.oneshot-gtm-workspaces/acme</string>",
    );
    expect(plist).toContain("<key>ONESHOT_GTM_WORKSPACE</key>\n    <string>acme</string>");
    expect(plist).toContain("<key>PORT</key>\n    <string>3031</string>");
    // A login must not open a browser tab.
    expect(plist).toContain("<key>ONESHOT_GTM_NO_BROWSER</key>\n    <string>1</string>");
    expect(plist).toContain(
      "<string>/Users/jo/.oneshot-gtm-workspaces/acme/dashboard.log</string>",
    );
  });

  it("carries the same binding in the systemd unit, quoted for paths with spaces", () => {
    const unit = renderSystemdService(
      dashboardService({ ...DASHBOARD, home: "/home/jo/gtm home", port: 4000 }),
    );
    expect(unit).toContain(
      'ExecStart="/opt/homebrew/bin/bun" "/Users/jo/oneshot-gtm/apps/server/src/bin.ts"\n',
    );
    expect(unit).toContain('Environment="ONESHOT_GTM_HOME=/home/jo/gtm home"');
    expect(unit).toContain('Environment="ONESHOT_GTM_WORKSPACE=acme"');
    expect(unit).toContain('Environment="PORT=4000"');
    expect(unit).toContain('Environment="ONESHOT_GTM_NO_BROWSER=1"');
    expect(unit).toContain("Description=oneshot-gtm dashboard — workspace acme on port 4000");
  });

  it("XML-escapes the home so an odd path still yields a valid plist", () => {
    const plist = renderLaunchdService(
      dashboardService({ ...DASHBOARD, home: "/Users/jo/a&b/<gtm>" }),
    );
    expect(plist).toContain("<string>/Users/jo/a&amp;b/&lt;gtm&gt;</string>");
    expect(plist).not.toContain("<gtm>");
  });

  it("is written and activated under its own name, not the watch daemon's", () => {
    const names = dashboardServiceNames("acme");
    expect(serviceWritePath("darwin", "/Users/jo", names)).toBe(
      "/Users/jo/Library/LaunchAgents/com.oneshot-gtm.workspace.acme.plist",
    );
    expect(serviceWritePath("linux", "/home/jo", names)).toBe(
      "/home/jo/.config/systemd/user/oneshot-gtm-workspace-acme.service",
    );
    const linux = activationHint("linux", "/home/jo/x.service", names).join("\n");
    expect(linux).toContain("systemctl --user enable --now oneshot-gtm-workspace-acme.service");
    expect(linux).not.toContain(SYSTEMD_UNIT);
  });

  it("says how to restart it after new code, per platform", () => {
    const names = dashboardServiceNames("acme");
    expect(restartHint("darwin", names)).toBe(
      "launchctl kickstart -k gui/$(id -u)/com.oneshot-gtm.workspace.acme",
    );
    expect(restartHint("linux", names)).toBe(
      "systemctl --user restart oneshot-gtm-workspace-acme.service",
    );
  });
});

describe("resolveDashboardServicePaths", () => {
  it("resolves the server entry, the home and a port from the active workspace", () => {
    const p = resolveDashboardServicePaths();
    expect(p.bunBin.startsWith("/")).toBe(true);
    expect(p.serverEntry.endsWith("/apps/server/src/bin.ts")).toBe(true);
    expect(p.home.startsWith("/")).toBe(true);
    expect(p.workspace.length).toBeGreaterThan(0);
    expect(Number.isInteger(p.port)).toBe(true);
  });

  it("lets --port override the workspace's registered port", () => {
    expect(resolveDashboardServicePaths(4123).port).toBe(4123);
  });
});
