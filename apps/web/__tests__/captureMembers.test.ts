import { afterEach, expect, it, vi } from "vitest";
import { captureBody } from "../scripts/capture-fixtures.ts";

afterEach(() => vi.unstubAllGlobals());

it("captures only fictional members without reading a reused demo home's roster", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      members: [{ email: "operator@example.com", name: "Private operator", role: "owner" }],
      allowedHosts: ["private.example.com"],
      currentMember: { email: "operator@example.com", name: "Private operator", role: "owner" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const body = await captureBody("/members", "/home/founder/demo");
  expect(body).toEqual({
    members: [
      {
        email: "mira@tracepoint.dev",
        name: "Mira Vance",
        role: "owner",
        addedAt: expect.any(String),
      },
    ],
    allowedHosts: [],
    currentMember: { email: "mira@tracepoint.dev", name: "Mira Vance", role: "owner" },
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("never captures the operator's current identity", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(await captureBody("/me", "/home/founder/demo")).toEqual({
    email: "mira@tracepoint.dev",
    name: "Mira Vance",
    role: "owner",
  });
  expect(fetch).not.toHaveBeenCalled();
});
