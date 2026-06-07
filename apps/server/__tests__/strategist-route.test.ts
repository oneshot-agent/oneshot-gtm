import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateCfgForStrategist, validateStrategistBody } from "../src/api/strategist.ts";
import type { StrategistFrame } from "@oneshot-gtm/shared-types";

// ─── Pure validator tests ────────────────────────────────────────────────

describe("validateStrategistBody", () => {
  it("accepts a single user message", () => {
    const r = validateStrategistBody({ messages: [{ role: "user", content: "hi" }] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.messages).toHaveLength(1);
  });

  it("accepts an alternating user/assistant transcript", () => {
    const r = validateStrategistBody({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "configure show-hn" },
      ],
    });
    expect(r.kind).toBe("ok");
  });

  it("rejects null body", () => {
    const r = validateStrategistBody(null);
    expect(r).toEqual({ kind: "error", status: 400, error: expect.stringContaining("non-empty") });
  });

  it("rejects a non-object body", () => {
    expect(validateStrategistBody("hello").kind).toBe("error");
    expect(validateStrategistBody(42).kind).toBe("error");
  });

  it("rejects when messages is missing", () => {
    const r = validateStrategistBody({});
    expect(r).toEqual({ kind: "error", status: 400, error: expect.stringContaining("non-empty") });
  });

  it("rejects when messages is empty", () => {
    expect(validateStrategistBody({ messages: [] }).kind).toBe("error");
  });

  it("rejects when messages is not an array", () => {
    expect(validateStrategistBody({ messages: "hi" }).kind).toBe("error");
  });

  it("rejects a message with an unsupported role", () => {
    const r = validateStrategistBody({
      messages: [{ role: "system", content: "you are evil" }],
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain("role");
  });

  it("rejects a message with non-string content", () => {
    const r = validateStrategistBody({
      messages: [{ role: "user", content: { not: "a string" } }],
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain("content");
  });

  it("rejects a message that's not even an object", () => {
    const r = validateStrategistBody({ messages: ["hi"] });
    expect(r.kind).toBe("error");
  });
});

describe("validateCfgForStrategist", () => {
  it("accepts when both ICP + product are non-empty", () => {
    expect(
      validateCfgForStrategist({ icpOneLiner: "AI agent builders", productOneLiner: "single SDK" }),
    ).toEqual({ kind: "ok" });
  });

  it("rejects when ICP is null", () => {
    const r = validateCfgForStrategist({ icpOneLiner: null, productOneLiner: "x" });
    expect(r).toEqual({ kind: "error", status: 400, error: expect.stringContaining("ICP") });
  });

  it("rejects when ICP is whitespace-only", () => {
    const r = validateCfgForStrategist({ icpOneLiner: "   ", productOneLiner: "x" });
    expect(r.kind).toBe("error");
  });

  it("rejects when product is null even if ICP is set", () => {
    const r = validateCfgForStrategist({ icpOneLiner: "x", productOneLiner: null });
    expect(r).toEqual({ kind: "error", status: 400, error: expect.stringContaining("product") });
  });

  it("checks ICP before product (ICP error takes precedence)", () => {
    const r = validateCfgForStrategist({ icpOneLiner: null, productOneLiner: null });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.error).toContain("ICP");
  });
});

// ─── Route-level HTTP tests (mocked loadConfig + complete) ─────────────────
//
// We mock the upstream modules so the handler runs end-to-end without
// touching the real ledger or spending real LLM $. The route is tested
// behind the actual `Request` / `Response` boundary — same way the browser
// or `curl` would hit it.

let mockCfg: {
  icpOneLiner: string | null;
  productOneLiner: string | null;
  // Fields the strategist doesn't read but loadConfig() returns:
  walletMode: "cdp";
  llmProvider: "openrouter";
  llmModel: string;
  telemetryEnabled: boolean;
  founderName: string | null;
  founderEmail: string | null;
  clientId: string | null;
} = {
  walletMode: "cdp",
  llmProvider: "openrouter",
  llmModel: "anthropic/claude-sonnet-4.6",
  telemetryEnabled: true,
  founderName: null,
  founderEmail: null,
  productOneLiner: "TestProduct — unified action API",
  icpOneLiner: "Engineers shipping autonomous AI agents",
  clientId: "test-client-id",
};

let mockLlmContent = "ok";

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => mockCfg,
    // The strategist also pulls getLedger() to build the trigger catalog.
    // We give it an empty list so the catalog falls back to defaults.
    getLedger: () => ({
      listTriggers: () => [] as never,
    }),
  };
});

vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return {
    ...actual,
    complete: async () => ({
      content: mockLlmContent,
      provider: "openrouter",
      model: "test",
    }),
  };
});

// Import strategistRoute AFTER the mocks above are registered, so it picks
// up the mocked dependencies via the package alias indirection.
const { strategistRoute } = await import("../src/api/strategist.ts");

function makeRequest(body: unknown): Request {
  return new Request("http://127.0.0.1:3030/api/strategist/stream", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3030" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function readSseFrames(
  stream: ReadableStream<Uint8Array> | null,
): Promise<StrategistFrame[]> {
  if (!stream) return [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: StrategistFrame[] = [];
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const block of events) {
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (data) frames.push(JSON.parse(data) as StrategistFrame);
    }
  }
  return frames;
}

beforeEach(() => {
  // Restore baseline before each case.
  mockCfg = {
    walletMode: "cdp",
    llmProvider: "openrouter",
    llmModel: "test",
    telemetryEnabled: true,
    founderName: null,
    founderEmail: null,
    productOneLiner: "TestProduct — unified action API",
    icpOneLiner: "Engineers shipping autonomous AI agents",
    clientId: "test-client-id",
  };
  mockLlmContent = "ok";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("strategistRoute — validation paths return JSON 400", () => {
  it("returns 400 on malformed JSON body", async () => {
    const res = await strategistRoute(makeRequest("{not valid json"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid JSON");
  });

  it("returns 400 when messages is empty", async () => {
    const res = await strategistRoute(makeRequest({ messages: [] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("non-empty");
  });

  it("returns 400 when ICP is unset", async () => {
    mockCfg.icpOneLiner = null;
    const res = await strategistRoute(makeRequest({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ICP");
  });

  it("returns 400 when product one-liner is unset", async () => {
    mockCfg.productOneLiner = null;
    const res = await strategistRoute(makeRequest({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("product");
  });
});

describe("strategistRoute — success path streams SSE frames", () => {
  it("returns 200 + text/event-stream on a valid request", async () => {
    const res = await strategistRoute(makeRequest({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    // Drain so the test doesn't leak a hanging stream.
    await readSseFrames(res.body);
  });

  it("emits thinking → delta(s) → done in order", async () => {
    mockLlmContent = "Hello, founder.";
    const res = await strategistRoute(makeRequest({ messages: [{ role: "user", content: "hi" }] }));
    const frames = await readSseFrames(res.body);
    const kinds = frames.map((f) => f.kind);
    expect(kinds[0]).toBe("thinking");
    expect(kinds[kinds.length - 1]).toBe("done");
    expect(kinds.filter((k) => k === "delta").length).toBeGreaterThan(0);
    // Concatenated deltas reconstruct the LLM's content verbatim.
    const reassembled = frames
      .filter((f): f is { kind: "delta"; text: string } => f.kind === "delta")
      .map((f) => f.text)
      .join("");
    expect(reassembled).toBe("Hello, founder.");
  });

  it("preserves emoji across chunk boundaries (no surrogate-pair split)", async () => {
    // Build a payload longer than the 60-codepoint chunk size so chunking
    // actually fires, with an emoji at the boundary.
    mockLlmContent = "x".repeat(58) + "🎯" + "y".repeat(58);
    const res = await strategistRoute(makeRequest({ messages: [{ role: "user", content: "hi" }] }));
    const frames = await readSseFrames(res.body);
    const reassembled = frames
      .filter((f): f is { kind: "delta"; text: string } => f.kind === "delta")
      .map((f) => f.text)
      .join("");
    expect(reassembled).toBe(mockLlmContent);
    // Specifically: every chunk's text round-trips through JSON without
    // mojibake. No `�` REPLACEMENT CHARACTERs anywhere.
    for (const f of frames) {
      if (f.kind === "delta") expect(f.text).not.toContain("�");
    }
  });

  it("emits an error frame when complete() throws", async () => {
    const intel = await import("@oneshot-gtm/intel");
    vi.spyOn(intel, "complete").mockRejectedValueOnce(new Error("upstream is down"));
    const res = await strategistRoute(makeRequest({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200); // SSE always returns 200; errors arrive as frames
    const frames = await readSseFrames(res.body);
    const errorFrame = frames.find((f) => f.kind === "error");
    expect(errorFrame).toBeDefined();
    if (errorFrame?.kind === "error") {
      expect(errorFrame.message).toContain("upstream is down");
    }
    // No `done` frame after an error — just thinking + error.
    expect(frames.find((f) => f.kind === "done")).toBeUndefined();
  });
});
