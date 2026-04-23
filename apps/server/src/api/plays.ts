import { getSequence } from "@oneshot-gtm/plays";
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

export function listPlays(req: Request): Response {
  const plays: PlayDescriptor[] = PLAY_CATALOG.map((p) => {
    const seq = getSequence(p.name);
    const channels: StepChannel[] = seq
      ? Array.from(new Set(seq.steps.map((s) => s.channel as StepChannel)))
      : ["email"];
    const followupCount = seq?.steps.length ?? 0;
    const hasBreakup = seq?.steps.some((s) => s.label?.toLowerCase().includes("breakup")) ?? false;
    return {
      name: p.name,
      channels,
      followupCount,
      hasBreakup,
      cliInvocation: p.cli,
    };
  });
  return jsonResponse({ plays }, 200, req);
}
