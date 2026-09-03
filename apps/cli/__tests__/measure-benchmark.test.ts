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
  vi.useRealTimers();
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

  it("stops reading benchmark responses larger than 512KB", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(256 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    await commandMeasureBenchmark({}, {});

    expect(stdout.join("")).toContain("Benchmark data is unavailable");
    expect(pulls).toBeLessThanOrEqual(4);
    expect(cancelled).toBe(true);
  });

  it("accepts a benchmark response exactly 512KB long", async () => {
    const json = JSON.stringify(aggregate);
    const body = `${json}${" ".repeat(512 * 1024 - Buffer.byteLength(json))}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    await commandMeasureBenchmark({ json: true }, {});

    expect(JSON.parse(stdout.join(""))).toMatchObject({ status: "ok", ...aggregate });
  });

  it("times out a benchmark request after 10 seconds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        });
      }),
    );

    const benchmark = commandMeasureBenchmark({}, {});
    await vi.advanceTimersByTimeAsync(10000);
    await benchmark;

    expect(signal?.aborted).toBe(true);
    expect(stdout.join("")).toContain("Benchmark data is unavailable");
  });

  it("times out while reading a stalled benchmark response", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal?.reason), {
              once: true,
            });
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const benchmark = commandMeasureBenchmark({}, {});
    await vi.advanceTimersByTimeAsync(10000);
    await benchmark;

    expect(signal?.aborted).toBe(true);
    expect(stdout.join("")).toContain("Benchmark data is unavailable");
  });
});
