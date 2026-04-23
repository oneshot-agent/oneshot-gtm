import { getLedger } from "@oneshot-gtm/core";
import type {
  EventsByPlay,
  OutcomeByPlay,
  OutcomeRequest,
  SpendByPlay,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

function readSinceDays(req: Request): string | undefined {
  const url = new URL(req.url);
  const n = Number.parseInt(url.searchParams.get("sinceDays") ?? "", 10);
  if (!Number.isFinite(n)) return undefined;
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

export function measureCac(req: Request): Response {
  const sinceIso = readSinceDays(req);
  const ledger = getLedger();
  const spend: SpendByPlay[] = ledger.spendByPlay(sinceIso ? { sinceIso } : {}).map((r) => ({
    playName: r.play_name,
    calls: r.calls,
    totalUsd: r.total_usd,
  }));
  const events: EventsByPlay[] = ledger.eventsByPlay(sinceIso ? { sinceIso } : {}).map((r) => ({
    playName: r.play_name,
    sent: r.sent,
    delivered: r.delivered,
    replied: r.replied,
    bounced: r.bounced,
  }));
  return jsonResponse({ spend, events }, 200, req);
}

export function measureRocs(req: Request): Response {
  const sinceIso = readSinceDays(req);
  const ledger = getLedger();
  const spend: SpendByPlay[] = ledger.spendByPlay(sinceIso ? { sinceIso } : {}).map((r) => ({
    playName: r.play_name,
    calls: r.calls,
    totalUsd: r.total_usd,
  }));
  const events: EventsByPlay[] = ledger.eventsByPlay(sinceIso ? { sinceIso } : {}).map((r) => ({
    playName: r.play_name,
    sent: r.sent,
    delivered: r.delivered,
    replied: r.replied,
    bounced: r.bounced,
  }));
  const outcomes: OutcomeByPlay[] = ledger
    .outcomesByPlay(sinceIso ? { sinceIso } : {})
    .map((r) => ({
      playName: r.play_name,
      meetings: r.meetings,
      sqls: r.sqls,
      won: r.won,
      lost: r.lost,
      ghosted: r.ghosted,
    }));
  return jsonResponse({ spend, events, outcomes }, 200, req);
}

export async function recordOutcome(req: Request): Promise<Response> {
  const body = (await req.json()) as OutcomeRequest;
  const allowed = ["meeting_booked", "sql_qualified", "deal_won", "deal_lost", "ghosted"];
  if (!allowed.includes(body.outcome)) {
    return jsonResponse({ error: `outcome must be one of: ${allowed.join(", ")}` }, 400, req);
  }
  const ledger = getLedger();
  const prospect = ledger.findProspectByEmail(body.email);
  if (!prospect) return jsonResponse({ error: `prospect not found: ${body.email}` }, 404, req);
  const id = ledger.recordOutcome({
    prospectId: prospect.id,
    ...(body.playName ? { playName: body.playName } : {}),
    outcome: body.outcome,
    ...(body.amountUsd != null ? { amountUsd: body.amountUsd } : {}),
    ...(body.notes ? { notes: body.notes } : {}),
  });
  return jsonResponse({ id }, 200, req);
}
