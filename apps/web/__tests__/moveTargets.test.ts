import { describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oneshot-gtm/shared-types";
import { moveTargets, movedRowUrl } from "../src/lib/moveTargets.ts";

const info = (workspaces: WorkspaceInfo["workspaces"]): WorkspaceInfo => ({
  current: { name: "sdk", home: "/h/sdk", port: 3032 },
  workspaces,
});
const ws = (
  name: string,
  port: number,
  over: Partial<WorkspaceInfo["workspaces"][number]> = {},
): WorkspaceInfo["workspaces"][number] => ({
  name,
  home: `/h/${name}`,
  port,
  isCurrent: false,
  isDefault: false,
  running: false,
  ...over,
});

describe("moveTargets", () => {
  it("lists every workspace but the current one, keeping the running flag", () => {
    expect(
      moveTargets(
        info([
          ws("default", 3030, { isDefault: true }),
          ws("sdk", 3032, { isCurrent: true, running: true }),
          ws("gtm", 3031, { running: true }),
        ]),
      ),
    ).toEqual([
      { name: "default", port: 3030, running: false },
      { name: "gtm", port: 3031, running: true },
    ]);
  });

  it("is empty with no roster or a single workspace, so the button never shows", () => {
    expect(moveTargets(undefined)).toEqual([]);
    expect(moveTargets(info([ws("sdk", 3032, { isCurrent: true, running: true })]))).toEqual([]);
  });

  it("points at the destination's pending queue on loopback", () => {
    expect(movedRowUrl(3031)).toBe("http://127.0.0.1:3031/queue?status=pending");
  });
});
