import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let telemetryEnabled = true;
let clientId: string | null = "install-123";

vi.mock("@oneshot-gtm/core", () => ({
  loadConfig: () => ({ telemetryEnabled, clientId }),
  shouldSendTelemetry: (cfg: { telemetryEnabled: boolean }, env: NodeJS.ProcessEnv) =>
    cfg.telemetryEnabled && env["ONESHOT_GTM_TELEMETRY"] !== "0",
  telemetryUrl: () => "https://telemetry.oneshotagent.com/v1/cli",
}));

const { commandMeasureBenchmark } = await import("../src/commands/measure.ts");
const { setJsonMode } = await import("../src/output.ts");

const aggregate = {
  cohortSize: 42,
  local: { commandsRun: 18, successRate: 0.75, medianDurationMs: 980 },
  cohort: { commandsRun: 12, successRate: 0.625, medianDurationMs: 1200 },
};

let stdout: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  telemetryEnabled = true;
  clientId = "install-123";
  stdout = [];
  stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(
      (
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | undefined) => void),
        callback?: (error?: Error | undefined) => void,
      ) => {
        stdout.push(String(chunk));
        if (typeof encodingOrCallback === "function") encodingOrCallback();
        else callback?.();
        return true;
      },
    );
});

afterEach(() => {
  stdoutSpy.mockRestore();
  setJsonMode(false);
  vi.unstubAllGlobals();
});

describe("measure benchmark", () => {
  it("renders the opted-in install against the cohort", async () => {
    const fetchMock = vi.fn(
      async (_input: URL) =>
        new Response(JSON.stringify(aggregate), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await commandMeasureBenchmark({}, {});

    const output = stdout.join("");
    expect(output).toContain("Your install vs 42 opted-in installs");
    expect(output).toContain("commands run");
    expect(output).toContain("18");
    expect(output).toContain("75.0%");
    expect(output).toContain("980 ms");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("anonymous_machine_id=install-123");
  });

  it("does not read aggregates and clearly explains when telemetry is opted out", async () => {
    telemetryEnabled = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await commandMeasureBenchmark({}, {});

    expect(stdout.join("")).toContain("Telemetry sharing is disabled");
    expect(stdout.join("")).toContain("config telemetry on");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", {}],
    ["malformed", { cohortSize: 3, local: null, cohort: { successRate: "lots" } }],
  ])("handles an %s aggregate response", async (_name, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );

    await commandMeasureBenchmark({}, {});

    expect(stdout.join("")).toContain("Benchmark data is unavailable");
  });

  it("emits the stable JSON shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(aggregate), { status: 200 })),
    );

    await commandMeasureBenchmark({ json: true }, {});

    expect(JSON.parse(stdout.join(""))).toEqual({
      schemaVersion: 1,
      command: "measure benchmark",
      status: "ok",
      ...aggregate,
    });
  });
});
