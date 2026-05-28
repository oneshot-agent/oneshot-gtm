import { loadConfig, saveConfig } from "@oneshot-gtm/core";
import { defaultSequence, getSequence, type Sequence } from "@oneshot-gtm/plays";
import type { PlayDescriptor, StepChannel } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

interface PlayMeta {
  name: string;
  cli: string;
}

const PLAY_CATALOG: PlayMeta[] = [
  {
    name: "show-hn",
    cli: "oneshot-gtm motion show-hn --target ./examples/show-hn.json",
  },
  {
    name: "job-change",
    cli: "oneshot-gtm motion job-change --target ./examples/job-change.json",
  },
  {
    name: "post-funding",
    cli: "oneshot-gtm motion post-funding --target ./examples/post-funding.json",
  },
  {
    name: "accelerator-batch",
    cli: "oneshot-gtm motion accelerator-batch --target ./examples/accelerator-batch.json --sender-cohort yc-w26",
  },
  {
    name: "concierge",
    cli: "oneshot-gtm motion concierge --target ./examples/concierge.json",
  },
  {
    name: "demo-no-show",
    cli: "oneshot-gtm motion demo-no-show --target ./examples/demo-no-show.json",
  },
  {
    name: "competitor-switch",
    cli: "oneshot-gtm motion competitor-switch --target ./examples/competitor-switch.json",
  },
  {
    name: "stack-consolidation",
    cli: "oneshot-gtm find watch  # fed by the github-topics finder, drained from /queue",
  },
  {
    name: "hiring-signal",
    cli: "oneshot-gtm motion hiring-signal --target ./examples/hiring-signal.json",
  },
  {
    name: "podcast-guest",
    cli: "oneshot-gtm motion podcast-guest --target ./examples/podcast-guest.json",
  },
  {
    name: "breakup-revive",
    cli: "oneshot-gtm motion breakup-revive --min-days 60 --max-days 90",
  },
];

/** Relative per-step dayOffsets → cumulative days from the day-0 initial send. */
function cumulativeDays(seq: Sequence | undefined): number[] {
  if (!seq) return [];
  let acc = 0;
  return seq.steps.map((s) => (acc += s.dayOffset));
}

export function listPlays(req: Request): Response {
  const plays: PlayDescriptor[] = PLAY_CATALOG.map((p) => {
    const seq = getSequence(p.name);
    const channels: StepChannel[] = seq
      ? Array.from(new Set(seq.steps.map((s) => s.channel as StepChannel)))
      : ["email"];
    const followupCount = seq?.steps.length ?? 0;
    const hasBreakup = seq?.steps.some((s) => s.label?.toLowerCase().includes("breakup")) ?? false;
    const days = cumulativeDays(seq);
    const steps = (seq?.steps ?? []).map((s, i) => ({
      day: days[i] ?? 0,
      label: s.label ?? `step ${i + 1}`,
      channel: s.channel as StepChannel,
    }));
    return {
      name: p.name,
      channels,
      followupCount,
      hasBreakup,
      cliInvocation: p.cli,
      steps,
      defaultDays: cumulativeDays(defaultSequence(p.name)),
    };
  });
  return jsonResponse({ plays }, 200, req);
}

/**
 * Set (or clear) per-play cadence timing. Body: { days: number[] | null }.
 * `days` are CUMULATIVE days from the initial send (intuitive in the UI); we
 * convert to the engine-native relative offsets before persisting. `null`
 * clears the override (reset to code defaults). Timing only — step structure
 * is fixed in code.
 */
export async function setCadenceRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const name = params["name"] ?? "";
  const def = defaultSequence(name);
  if (!def || def.steps.length === 0) {
    return jsonResponse({ error: `play '${name}' has no editable cadence` }, 400, req);
  }

  let body: { days?: number[] | null };
  try {
    body = (await req.json()) as { days?: number[] | null };
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400, req);
  }

  const cfg = loadConfig();
  const overrides = { ...cfg.cadenceOverrides };

  // Reset path: clear this play's override.
  if (body.days === null || body.days === undefined) {
    delete overrides[name];
    saveConfig({
      ...cfg,
      cadenceOverrides: Object.keys(overrides).length > 0 ? overrides : null,
    });
    return jsonResponse({ ok: true }, 200, req);
  }

  const days = body.days;
  const stepCount = def.steps.length;
  if (!Array.isArray(days) || days.length !== stepCount) {
    return jsonResponse(
      { error: `days must be an array of ${stepCount} cumulative day value(s)` },
      400,
      req,
    );
  }
  if (!days.every((d) => Number.isInteger(d) && d >= 1 && d <= 120)) {
    return jsonResponse({ error: "each day must be an integer between 1 and 120" }, 400, req);
  }
  for (let i = 1; i < days.length; i++) {
    if ((days[i] as number) <= (days[i - 1] as number)) {
      return jsonResponse({ error: "days must be strictly increasing" }, 400, req);
    }
  }

  // Cumulative → relative offsets (each ≥ 1, guaranteed by the checks above).
  const relative = days.map((d, i) => (i === 0 ? d : d - (days[i - 1] as number)));
  overrides[name] = relative;
  saveConfig({ ...cfg, cadenceOverrides: overrides });
  return jsonResponse({ ok: true }, 200, req);
}
