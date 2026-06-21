import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTelemetryPayload,
  DEFAULT_TELEMETRY_URL,
  markTelemetryOutcome,
  reportCommand,
  reportTelemetryEvent,
  shouldSendTelemetry,
  takeMarkedOutcome,
  telemetryUrl,
  type TelemetryInputs,
} from "../src/telemetry.ts";

const BASE: TelemetryInputs = {
  command: "motion show-hn",
  flags: ["dry-run"],
  outcome: "ok",
  durationMs: 2840.6,
  version: "0.6.0",
  clientId: "cid-123",
  llmProvider: "openrouter",
  platform: "darwin",
  bunVersion: "1.3.13",
};

describe("buildTelemetryPayload — exactly the TELEMETRY.md whitelist", () => {
  it("maps inputs onto the documented field names", () => {
    const p = buildTelemetryPayload(BASE);
    expect(p).toEqual({
      command: "motion show-hn",
      flags: ["dry-run"],
      outcome: "ok",
      duration_ms: 2841, // rounded
      version: "0.6.0",
      os: "darwin",
      bun_version: "1.3.13",
      anonymous_machine_id: "cid-123",
      llm_provider: "openrouter",
    });
  });

  it("carries no field outside the whitelist", () => {
    const keys = Object.keys(buildTelemetryPayload(BASE)).toSorted();
    expect(keys).toEqual([
      "anonymous_machine_id",
      "bun_version",
      "command",
      "duration_ms",
      "flags",
      "llm_provider",
      "os",
      "outcome",
      "version",
    ]);
  });

  it("passes flags through as-is (names only — caller never puts values here)", () => {
    const p = buildTelemetryPayload({ ...BASE, flags: ["dry-run", "skip-sms"] });
    expect(p.flags).toEqual(["dry-run", "skip-sms"]);
  });

  it("rounds and floors duration to a non-negative integer", () => {
    expect(buildTelemetryPayload({ ...BASE, durationMs: -5 }).duration_ms).toBe(0);
    expect(buildTelemetryPayload({ ...BASE, durationMs: 12.4 }).duration_ms).toBe(12);
  });

  it("preserves a null anonymous id (install without a clientId yet)", () => {
    expect(buildTelemetryPayload({ ...BASE, clientId: null }).anonymous_machine_id).toBeNull();
  });
});

describe("shouldSendTelemetry — gate", () => {
  it("is on by default when the flag is true and no env override", () => {
    expect(shouldSendTelemetry({ telemetryEnabled: true }, {})).toBe(true);
  });

  it("is off when the persisted flag is false", () => {
    expect(shouldSendTelemetry({ telemetryEnabled: false }, {})).toBe(false);
  });

  it.each(["0", "false", "off", "no", "FALSE", "Off"])(
    "env kill switch ONESHOT_GTM_TELEMETRY=%s wins over flag=true",
    (val) => {
      expect(shouldSendTelemetry({ telemetryEnabled: true }, { ONESHOT_GTM_TELEMETRY: val })).toBe(
        false,
      );
    },
  );

  it("a truthy-looking env value (e.g. '1') does not force-disable", () => {
    expect(shouldSendTelemetry({ telemetryEnabled: true }, { ONESHOT_GTM_TELEMETRY: "1" })).toBe(
      true,
    );
  });
});

describe("telemetryUrl", () => {
  it("defaults to the first-party endpoint", () => {
    expect(telemetryUrl({})).toBe(DEFAULT_TELEMETRY_URL);
  });

  it("honors ONESHOT_GTM_TELEMETRY_URL override", () => {
    expect(telemetryUrl({ ONESHOT_GTM_TELEMETRY_URL: "http://localhost:9/x" })).toBe(
      "http://localhost:9/x",
    );
  });

  it("treats an explicitly-empty override as a no-op (empty string), not the default", () => {
    // honors the documented `ONESHOT_GTM_TELEMETRY_URL=""` kill path
    expect(telemetryUrl({ ONESHOT_GTM_TELEMETRY_URL: "" })).toBe("");
    expect(telemetryUrl({ ONESHOT_GTM_TELEMETRY_URL: "   " })).toBe("");
  });
});

describe("reportCommand — transport", () => {
  afterEach(() => vi.restoreAllMocks());

  const payload = buildTelemetryPayload(BASE);

  it("is a no-op when the URL is empty (unconfigured / forked build)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await reportCommand(payload, "");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs JSON to the configured URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    await reportCommand(payload, "http://ingest.local/v1/cli");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://ingest.local/v1/cli");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toMatchObject({ command: "motion show-hn" });
  });

  it("never throws when fetch rejects (endpoint down)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(reportCommand(payload, "http://ingest.local/v1/cli")).resolves.toBeUndefined();
  });
});

describe("reportTelemetryEvent — shared send path (gate + payload)", () => {
  afterEach(() => vi.restoreAllMocks());

  const event = {
    command: "motion show-hn",
    flags: ["dry-run"],
    outcome: "ok" as const,
    durationMs: 12,
    version: "9.9.9",
  };

  it("is a no-op when the env kill-switch disables telemetry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await reportTelemetryEvent(event, { ONESHOT_GTM_TELEMETRY: "0" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("builds and POSTs a payload (caller's version, host-stamped os) when enabled", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    await reportTelemetryEvent(event, {}); // empty env → not disabled, default URL
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(payload["command"]).toBe("motion show-hn");
    expect(payload["version"]).toBe("9.9.9");
    expect(payload["os"]).toBe(process.platform);
  });

  it("never throws when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(reportTelemetryEvent(event, {})).resolves.toBeUndefined();
  });
});

describe("markTelemetryOutcome / takeMarkedOutcome", () => {
  it("returns null when nothing was marked", () => {
    takeMarkedOutcome(); // clear any residue
    expect(takeMarkedOutcome()).toBeNull();
  });

  it("returns the marked outcome once, then clears", () => {
    markTelemetryOutcome("lint-blocked");
    expect(takeMarkedOutcome()).toBe("lint-blocked");
    expect(takeMarkedOutcome()).toBeNull();
  });
});
