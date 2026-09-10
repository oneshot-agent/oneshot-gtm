import { beforeEach, expect, it, vi } from "vitest";

const getTrigger = vi.fn();
vi.mock("@oneshot-gtm/core", () => ({ getLedger: () => ({ getTrigger }) }));
const { resolveQueueTarget } = await import("../src/queue-target.ts");
const payload_json = JSON.stringify({
  email: "a@example.com",
  yourEdge: "old comparison",
  dossier: "facts",
});
beforeEach(() => getTrigger.mockReset());

it("refreshes edges on each generation while preserving saved facts and payload", () => {
  const row = { source: "find:luma-events", payload_json };
  getTrigger.mockReturnValue({
    config_json: JSON.stringify({ yourEdge: "the product is the playbook" }),
  });
  expect(resolveQueueTarget(row)).toEqual({
    email: "a@example.com",
    yourEdge: "the product is the playbook",
    dossier: "facts",
  });
  getTrigger.mockReturnValue({ config_json: JSON.stringify({ yourEdge: "new angle" }) });
  expect(resolveQueueTarget(row)).toHaveProperty("yourEdge", "new angle");
  expect(row.payload_json).toBe(payload_json);
});

it.each(["", null])("honors a cleared edge (%s)", (yourEdge) => {
  getTrigger.mockReturnValue({ config_json: JSON.stringify({ yourEdge }) });
  expect(resolveQueueTarget({ source: "find:luma-events", payload_json })).toHaveProperty(
    "yourEdge",
    "",
  );
});

it("resolves source suffixes and does not conflate finders sharing a play", () => {
  getTrigger.mockImplementation((name: string) => ({
    config_json: JSON.stringify({ yourEdge: name }),
  }));
  for (const name of ["github-stars", "github-topics", "accelerator-batch"]) {
    expect(resolveQueueTarget({ source: `find:${name}:owner/repo`, payload_json })).toHaveProperty(
      "yourEdge",
      name,
    );
  }
});

it("refreshes yourClaim", () => {
  getTrigger.mockReturnValue({ config_json: JSON.stringify({ yourClaim: "current claim" }) });
  expect(resolveQueueTarget({ source: "find:hiring-signal", payload_json })).toHaveProperty(
    "yourClaim",
    "current claim",
  );
});

it.each([null, { config_json: null }, { config_json: "{}" }])(
  "retains saved edges when unavailable (%j)",
  (trigger) => {
    getTrigger.mockReturnValue(trigger);
    expect(resolveQueueTarget({ source: "find:luma-events", payload_json })).toEqual(
      JSON.parse(payload_json),
    );
  },
);

it.each(["", "{", "[]", "null", '{"yourEdge":123}'])(
  "rejects malformed configuration (%s)",
  (config_json) => {
    getTrigger.mockReturnValue({ config_json });
    expect(() => resolveQueueTarget({ source: "find:luma-events", payload_json })).toThrow(
      /Invalid/,
    );
  },
);

it.each(["csv:import", "manual", ""])(
  "preserves targets without finder provenance (%s)",
  (source) => {
    expect(resolveQueueTarget({ source, payload_json })).toEqual(JSON.parse(payload_json));
    expect(getTrigger).not.toHaveBeenCalled();
  },
);
