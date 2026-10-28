import { describe, expect, it } from "vitest";
import { parseServerArgs } from "../src/args.ts";

const registered = (): number => 4032;
const never = (): number => {
  throw new Error("registry read when a port was given");
};

describe("parseServerArgs — oneshot-gtm-server flags", () => {
  it("--port wins over PORT and the registered port", () => {
    expect(parseServerArgs(["--port", "4099"], { PORT: "4031" }, registered)).toEqual({
      kind: "run",
      port: 4099,
      noBrowser: false,
    });
    expect(parseServerArgs(["--port=4098"], {}, registered)).toMatchObject({ port: 4098 });
  });

  it("PORT is used when no flag is given (launchd services set it)", () => {
    expect(parseServerArgs([], { PORT: "4031" }, registered)).toMatchObject({ port: 4031 });
  });

  it("falls back to the workspace's registered port, asked only when needed", () => {
    expect(parseServerArgs([], {}, registered)).toMatchObject({ port: 4032 });
    expect(parseServerArgs([], { PORT: "" }, registered)).toMatchObject({ port: 4032 });
    expect(parseServerArgs(["--port", "4099"], {}, never)).toMatchObject({ port: 4099 });
  });

  it("refuses an unknown argument instead of ignoring it", () => {
    expect(parseServerArgs(["--prot", "4099"], {}, registered)).toEqual({
      kind: "error",
      message: "unknown argument: --prot",
    });
  });

  it("refuses a missing or invalid port", () => {
    expect(parseServerArgs(["--port"], {}, registered)).toMatchObject({ kind: "error" });
    expect(parseServerArgs(["--port", "abc"], {}, registered)).toMatchObject({ kind: "error" });
    expect(parseServerArgs(["--port", "70000"], {}, registered)).toMatchObject({ kind: "error" });
    expect(parseServerArgs([], { PORT: "x" }, registered)).toMatchObject({ kind: "error" });
  });

  it("--help, and --no-browser or ONESHOT_GTM_NO_BROWSER=1", () => {
    expect(parseServerArgs(["--port", "4099", "-h"], {}, registered)).toEqual({ kind: "help" });
    expect(parseServerArgs(["--help"], {}, registered)).toEqual({ kind: "help" });
    expect(parseServerArgs(["--no-browser"], {}, registered)).toMatchObject({ noBrowser: true });
    expect(parseServerArgs([], { ONESHOT_GTM_NO_BROWSER: "1" }, registered)).toMatchObject({
      noBrowser: true,
    });
  });
});
