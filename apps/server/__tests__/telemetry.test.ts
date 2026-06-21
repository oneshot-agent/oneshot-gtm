import { afterEach, describe, expect, it, vi } from "vitest";
import { reportServerExecution } from "../src/telemetry.ts";

// reportServerExecution reaches the real telemetry endpoint via global fetch,
// so every test that exercises the send path must spy on fetch — otherwise it
// would phone home. Tests run under ONESHOT_GTM_HOME = a temp dir (see
// vitest.setup.ts), so loadConfig() reads a fresh config with telemetry on by
// default.

const ENV_KEY = "ONESHOT_GTM_TELEMETRY";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[ENV_KEY];
});

describe("reportServerExecution — gate", () => {
  it("is a no-op when the env kill-switch is set (no fetch)", async () => {
    process.env[ENV_KEY] = "0";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await reportServerExecution("server.run.show-hn", { outcome: "ok", durationMs: 5 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("reportServerExecution — transport", () => {
  it("POSTs a server.-prefixed payload with the right command/flags/outcome", async () => {
    delete process.env[ENV_KEY];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await reportServerExecution("server.run.show-hn", {
      outcome: "ok",
      durationMs: 1234,
      flags: ["dry-run", "from-queue"],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1];
    expect(init?.method).toBe("POST");
    const payload = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(payload["command"]).toBe("server.run.show-hn");
    expect(payload["flags"]).toEqual(["dry-run", "from-queue"]);
    expect(payload["outcome"]).toBe("ok");
    expect(payload["duration_ms"]).toBe(1234);
    // Server build carries a real version + platform — proves it's a server
    // event, not a CLI one.
    expect(typeof payload["version"]).toBe("string");
    expect(payload["os"]).toBe(process.platform);
  });

  it("defaults flags to an empty array when omitted", async () => {
    delete process.env[ENV_KEY];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    await reportServerExecution("server.trigger.show-hn", { outcome: "error", durationMs: 0 });
    const payload = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(payload["flags"]).toEqual([]);
    expect(payload["outcome"]).toBe("error");
  });

  it("never throws when fetch rejects (endpoint down must not break a request)", async () => {
    delete process.env[ENV_KEY];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      reportServerExecution("server.queue.drain", { outcome: "ok", durationMs: 9 }),
    ).resolves.toBeUndefined();
  });
});
