import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import populated from "./fixtures/benchmarks/populated.json";
import empty from "./fixtures/benchmarks/empty.json";
import zeroDenominator from "./fixtures/benchmarks/zero-denominator.json";
import { buildFetchHandler } from "../src/server.ts";
import { publicBenchmarks } from "../src/api/benchmarks.ts";

const handler = buildFetchHandler();
const request = (path: string, method = "GET") =>
  handler(
    new Request(`http://127.0.0.1:3030${path}`, { method, headers: { host: "127.0.0.1:3030" } }),
  );

function upstream(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) =>
    Response.json(body, { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv("ONESHOT_GTM_BENCHMARK_URL", "https://aggregate.example/v1/benchmark");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("public benchmarks", () => {
  it("serves populated cohort metrics with units and the available sample count", async () => {
    upstream(populated);
    const response = await request("/benchmarks");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    for (const text of [
      "Public benchmarks",
      "42 installs",
      "12 commands",
      "62.5%",
      "1,200 ms",
      "separate sample counts",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/private-|private@|anonymous_machine_id/);
  });

  it.each([
    ["empty", empty, "No benchmark samples yet.", 0],
    ["zero denominator", zeroDenominator, "3 installs", 3],
  ])(
    "renders %s without inventing rates or producing non-finite values",
    async (_name, fixture, message, cohortSize) => {
      upstream(fixture);
      const response = await request("/api/benchmarks");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        cohortSize,
        cohort: { commandsRun: 0, successRate: null, medianDurationMs: null },
      });
      const html = await (await request("/benchmarks")).text();
      expect(html).toContain(message);
      expect(html).toContain("Not available — no commands sampled");
      expect(html).not.toMatch(/NaN|Infinity|0\.0%/);
    },
  );

  it("allows only cohort fields and never forwards identifiers or caller credentials", async () => {
    vi.stubEnv(
      "ONESHOT_GTM_BENCHMARK_URL",
      "https://aggregate.example/v1/benchmark?anonymous_machine_id=private-install",
    );
    const fetchMock = upstream(populated);
    const response = await handler(
      new Request("http://127.0.0.1:3030/api/benchmarks?anonymous_machine_id=caller", {
        headers: {
          host: "127.0.0.1:3030",
          cookie: "session=private",
          authorization: "Bearer private",
        },
      }),
    );
    expect(await response.json()).toEqual({
      cohortSize: 42,
      cohort: { commandsRun: 12, successRate: 0.625, medianDurationMs: 1200 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url.toString()).toBe("https://aggregate.example/v1/benchmark");
    expect(init?.headers).toEqual({ accept: "application/json" });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("is read-only and preserves the server host guard", async () => {
    const fetchMock = upstream(populated);
    expect((await request("/benchmarks", "POST")).status).toBe(405);
    expect((await request("/api/benchmarks", "POST")).status).toBe(404);
    expect(
      (
        await handler(
          new Request("http://evil.example/benchmarks", { headers: { host: "evil.example" } }),
        )
      ).status,
    ).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps unavailable responses generic for upstream failures and malformed data", async () => {
    for (const body of [{}, { ...populated, cohort: { ...populated.cohort, successRate: 2 } }]) {
      upstream(body);
      expect((await request("/api/benchmarks")).status).toBe(503);
    }
    upstream({ error: "private upstream detail" }, 500);
    const response = await request("/api/benchmarks");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Benchmark data is unavailable. Try again later.",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("private upstream detail");
      }),
    );
    const page = await request("/benchmarks");
    expect(page.status).toBe(503);
    const html = await page.text();
    expect(html).toContain("Benchmark data is unavailable");
    expect(html).not.toContain("private upstream detail");
  });

  it("rejects non-finite metrics and normalizes undefined rates when no commands exist", () => {
    expect(
      publicBenchmarks({ ...populated, cohort: { ...populated.cohort, successRate: NaN } }),
    ).toBeNull();
    expect(
      publicBenchmarks({
        ...populated,
        cohort: { ...populated.cohort, medianDurationMs: Infinity },
      }),
    ).toBeNull();
    expect(
      publicBenchmarks({
        ...zeroDenominator,
        cohort: { commandsRun: 0, successRate: NaN, medianDurationMs: Infinity },
      })?.cohort,
    ).toEqual({ commandsRun: 0, successRate: null, medianDurationMs: null });
  });
});
