import { describe, expect, it } from "vitest";
import { parseStrategistAction, stripActionMarkers } from "../src/lib/strategistAction.ts";

describe("parseStrategistAction — kind + trigger", () => {
  // Regression: the previous regex `[^:>-]+` excluded `-` from the trigger
  // capture, silently breaking every multi-word trigger. These cases were
  // confirmed broken before the fix; they MUST stay green.
  it.each([
    "show-hn",
    "accelerator-batch",
    "post-funding-auto",
    "job-change",
    "hiring-signal",
    "podcast-guest",
    "github-topics",
    "breakup-revive",
  ])("parses an enable marker for %s", (trigger) => {
    const r = parseStrategistAction(`<!--ACTION:enable:${trigger}-->`);
    expect(r).toEqual({ kind: "enable", trigger });
  });

  it("parses a disable marker", () => {
    expect(parseStrategistAction("<!--ACTION:disable:github-topics-->")).toEqual({
      kind: "disable",
      trigger: "github-topics",
    });
  });
});

describe("parseStrategistAction — apply-config JSON", () => {
  it("parses a single-field config", () => {
    const m = `<!--ACTION:apply-config:github-topics:{"limit":25,"yourEdge":"x"}-->`;
    const r = parseStrategistAction(m);
    expect(r?.kind).toBe("apply-config");
    expect(r?.trigger).toBe("github-topics");
    expect(r?.config).toEqual({ limit: 25, yourEdge: "x" });
  });

  it("parses a multi-field config with embedded colons + quotes", () => {
    const m = `<!--ACTION:apply-config:github-topics:{"topics":["llm-agents","ai-agent"],"vendors":["Stripe","Twilio","Anthropic","Inngest"],"yourEdge":"unified SDK","minStars":10}-->`;
    const r = parseStrategistAction(m);
    expect(r?.kind).toBe("apply-config");
    const topics = (r?.config?.["topics"] ?? []) as string[];
    const vendors = (r?.config?.["vendors"] ?? []) as string[];
    expect(topics).toEqual(["llm-agents", "ai-agent"]);
    expect(vendors).toEqual(["Stripe", "Twilio", "Anthropic", "Inngest"]);
    expect(r?.config?.["yourEdge"]).toBe("unified SDK");
  });

  it("returns null when the JSON is malformed", () => {
    expect(parseStrategistAction("<!--ACTION:apply-config:show-hn:{not-json}-->")).toBeNull();
  });

  it("returns null when the payload is JSON null", () => {
    expect(parseStrategistAction("<!--ACTION:apply-config:show-hn:null-->")).toBeNull();
  });

  it("returns null when the payload is a JSON array", () => {
    expect(parseStrategistAction("<!--ACTION:apply-config:show-hn:[1,2,3]-->")).toBeNull();
  });
});

describe("parseStrategistAction — edge cases", () => {
  it("returns null when no marker is present", () => {
    expect(parseStrategistAction("just some prose")).toBeNull();
  });

  it("returns null on a partial marker (no closing -->)", () => {
    expect(
      parseStrategistAction('<!--ACTION:apply-config:github-topics:{"limit":25,"yourEdge":"x'),
    ).toBeNull();
  });

  it("ignores prose around the marker", () => {
    const m = `Sure — let's enable show-hn.\n\n<!--ACTION:enable:show-hn-->`;
    expect(parseStrategistAction(m)).toEqual({ kind: "enable", trigger: "show-hn" });
  });

  it("matches the FIRST marker when multiple are present", () => {
    const m = `<!--ACTION:enable:show-hn--><!--ACTION:disable:show-hn-->`;
    expect(parseStrategistAction(m)?.kind).toBe("enable");
  });

  it("trims whitespace from the trigger name", () => {
    expect(parseStrategistAction("<!--ACTION:enable: show-hn -->")?.trigger).toBe("show-hn");
  });

  it("returns null when the trigger name is blank", () => {
    expect(parseStrategistAction("<!--ACTION:enable:-->")).toBeNull();
  });
});

describe("stripActionMarkers", () => {
  it("strips a complete marker and trims the prose", () => {
    const out = stripActionMarkers("Enabling show-hn now.\n\n<!--ACTION:enable:show-hn-->");
    expect(out).toBe("Enabling show-hn now.");
  });

  it("strips a partial marker mid-stream so it doesn't flicker into view", () => {
    // The closing `-->` hasn't arrived yet — the partial regex must still
    // hide the marker scaffolding from the founder.
    const out = stripActionMarkers(`Adding the config:\n\n<!--ACTION:apply-config:agent-bui`);
    expect(out).toBe("Adding the config:");
  });

  it("leaves prose intact when no marker is present", () => {
    expect(stripActionMarkers("Hello world.")).toBe("Hello world.");
  });

  it("strips both a complete and a trailing partial marker", () => {
    const out = stripActionMarkers(
      "First action.\n\n<!--ACTION:enable:show-hn-->\n\n<!--ACTION:apply",
    );
    expect(out).toBe("First action.");
  });
});
