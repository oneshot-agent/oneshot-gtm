import { getLedger } from "@oneshot-gtm/core";
import { box, c, fail, header, note, ok } from "../output.ts";

export function commandMeasureReceipt(idStr: string): void {
  const id = Number.parseInt(idStr, 10);
  if (!Number.isFinite(id)) throw new Error(`invalid receipt id: ${idStr}`);
  const r = getLedger().getReceipt(id);
  if (!r) {
    process.stdout.write(`${c.red("not found:")} receipt #${id}\n`);
    process.exit(1);
  }
  header(`receipt #${r.id}`);
  note(`play: ${c.cyan(r.play_name)}  type: ${c.cyan(r.call_type)}  at: ${c.dim(r.created_at)}`);
  if (r.cost_usd != null) note(`cost: ${c.green(`$${r.cost_usd.toFixed(4)}`)}`);
  if (r.oneshot_request_id) note(`request_id: ${c.dim(r.oneshot_request_id)}`);
  if (r.signed_receipt) {
    box("signed receipt (raw)", r.signed_receipt.slice(0, 4000));
  } else {
    note("(no signed receipt body recorded)");
  }
}

export function commandMeasureCac(opts: { sinceDays?: number }): void {
  header("measure cac — per-play unit economics");
  const ledger = getLedger();
  const sinceIso = opts.sinceDays
    ? new Date(Date.now() - opts.sinceDays * 24 * 3600 * 1000).toISOString()
    : undefined;

  if (sinceIso) note(`since: ${c.dim(sinceIso)}\n`);

  const spend = ledger.spendByPlay(sinceIso ? { sinceIso } : {});
  const events = ledger.eventsByPlay(sinceIso ? { sinceIso } : {});
  const eventsByName = new Map(events.map((e) => [e.play_name, e]));

  if (spend.length === 0) {
    note("No receipts logged yet. Run a play, then come back.");
    return;
  }

  const headers = ["play", "calls", "spend", "sent", "replied", "$/send", "$/reply"];
  const rows: string[][] = [headers.map((h) => c.bold(h))];

  let totalSpend = 0;
  let totalCalls = 0;
  let totalSent = 0;
  let totalReplied = 0;

  for (const s of spend) {
    const ev = eventsByName.get(s.play_name);
    const sent = ev?.sent ?? 0;
    const replied = ev?.replied ?? 0;
    const perSend = sent > 0 ? s.total_usd / sent : null;
    const perReply = replied > 0 ? s.total_usd / replied : null;
    totalSpend += s.total_usd;
    totalCalls += s.calls;
    totalSent += sent;
    totalReplied += replied;
    rows.push([
      c.cyan(s.play_name),
      String(s.calls),
      `$${s.total_usd.toFixed(2)}`,
      String(sent),
      String(replied),
      perSend != null ? `$${perSend.toFixed(3)}` : c.dim("—"),
      perReply != null ? c.green(`$${perReply.toFixed(2)}`) : c.dim("—"),
    ]);
  }

  rows.push([
    c.bold("TOTAL"),
    c.bold(String(totalCalls)),
    c.bold(`$${totalSpend.toFixed(2)}`),
    c.bold(String(totalSent)),
    c.bold(String(totalReplied)),
    totalSent > 0 ? c.bold(`$${(totalSpend / totalSent).toFixed(3)}`) : c.dim("—"),
    totalReplied > 0 ? c.bold(c.green(`$${(totalSpend / totalReplied).toFixed(2)}`)) : c.dim("—"),
  ]);

  printTable(rows);

  process.stdout.write(
    `\n${c.dim(
      "$/send and $/reply are derived from signed receipts. Export with: oneshot-gtm measure receipt <id>",
    )}\n`,
  );
}

export function commandMeasureRocs(opts: { sinceDays?: number }): void {
  header("measure rocs — Return on Cognitive Spend");
  const ledger = getLedger();
  const sinceIso = opts.sinceDays
    ? new Date(Date.now() - opts.sinceDays * 24 * 3600 * 1000).toISOString()
    : undefined;
  if (sinceIso) note(`since: ${c.dim(sinceIso)}\n`);

  const spend = ledger.spendByPlay(sinceIso ? { sinceIso } : {});
  const events = ledger.eventsByPlay(sinceIso ? { sinceIso } : {});
  const outcomes = ledger.outcomesByPlay(sinceIso ? { sinceIso } : {});
  const eventsBy = new Map(events.map((e) => [e.play_name, e]));
  const outcomesBy = new Map(outcomes.map((o) => [o.play_name ?? "(unattributed)", o]));

  if (spend.length === 0 && outcomes.length === 0) {
    note(
      "No receipts or outcomes recorded yet. Run a play, log outcomes with: oneshot-gtm measure outcome",
    );
    return;
  }

  const headers = [
    "play",
    "spend",
    "sent",
    "replied",
    "meetings",
    "SQLs",
    "won",
    "$/meeting",
    "$/SQL",
    "$/won",
  ];
  const rows: string[][] = [headers.map((h) => c.bold(h))];

  let tSpend = 0;
  let tSent = 0;
  let tRep = 0;
  let tMeet = 0;
  let tSql = 0;
  let tWon = 0;

  const playNames = new Set<string>();
  for (const s of spend) playNames.add(s.play_name);
  for (const o of outcomes) if (o.play_name) playNames.add(o.play_name);

  for (const name of [...playNames].toSorted()) {
    const s = spend.find((x) => x.play_name === name);
    const ev = eventsBy.get(name);
    const oc = outcomesBy.get(name);
    const sp = s?.total_usd ?? 0;
    const sent = ev?.sent ?? 0;
    const rep = ev?.replied ?? 0;
    const meet = oc?.meetings ?? 0;
    const sql = oc?.sqls ?? 0;
    const won = oc?.won ?? 0;
    tSpend += sp;
    tSent += sent;
    tRep += rep;
    tMeet += meet;
    tSql += sql;
    tWon += won;
    rows.push([
      c.cyan(name),
      `$${sp.toFixed(2)}`,
      String(sent),
      String(rep),
      String(meet),
      String(sql),
      c.green(String(won)),
      meet > 0 ? `$${(sp / meet).toFixed(2)}` : c.dim("—"),
      sql > 0 ? `$${(sp / sql).toFixed(2)}` : c.dim("—"),
      won > 0 ? c.green(`$${(sp / won).toFixed(2)}`) : c.dim("—"),
    ]);
  }

  rows.push([
    c.bold("TOTAL"),
    c.bold(`$${tSpend.toFixed(2)}`),
    c.bold(String(tSent)),
    c.bold(String(tRep)),
    c.bold(String(tMeet)),
    c.bold(String(tSql)),
    c.bold(c.green(String(tWon))),
    tMeet > 0 ? c.bold(`$${(tSpend / tMeet).toFixed(2)}`) : c.dim("—"),
    tSql > 0 ? c.bold(`$${(tSpend / tSql).toFixed(2)}`) : c.dim("—"),
    tWon > 0 ? c.bold(c.green(`$${(tSpend / tWon).toFixed(2)}`)) : c.dim("—"),
  ]);

  printTable(rows);
  process.stdout.write(
    `\n${c.dim(
      "RoCS = total signed-receipt spend ÷ qualifying outcome. Log outcomes with: oneshot-gtm measure outcome <prospect-email> <meeting_booked|sql_qualified|deal_won|deal_lost|ghosted>",
    )}\n`,
  );
}

export function commandMeasureOutcome(args: {
  email: string;
  outcome: string;
  play?: string;
  amount?: number;
  notes?: string;
}): void {
  const allowed = ["meeting_booked", "sql_qualified", "deal_won", "deal_lost", "ghosted"];
  if (!allowed.includes(args.outcome)) {
    fail(`outcome must be one of: ${allowed.join(", ")}`);
    process.exit(1);
  }
  const ledger = getLedger();
  const prospect = ledger.findProspectByEmail(args.email);
  if (!prospect) {
    fail(`prospect not found: ${args.email}. Run a motion play first.`);
    process.exit(1);
  }
  const id = ledger.recordOutcome({
    prospectId: prospect.id,
    ...(args.play ? { playName: args.play } : {}),
    outcome: args.outcome as never,
    ...(args.amount != null ? { amountUsd: args.amount } : {}),
    ...(args.notes ? { notes: args.notes } : {}),
  });
  ok(`recorded outcome #${id}: ${args.outcome} for ${args.email}`);
}

function printTable(rows: string[][]): void {
  if (rows.length === 0) return;
  const cols = rows[0]?.length ?? 0;
  const widths: number[] = Array.from({ length: cols }, () => 0);
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      const cell = row[i] ?? "";
      const visible = cell.replace(/\[[0-9;]*m/g, "");
      if (visible.length > (widths[i] ?? 0)) widths[i] = visible.length;
    }
  }
  process.stdout.write("\n");
  for (const row of rows) {
    const padded = row.map((cell, i) => {
      const visible = cell.replace(/\[[0-9;]*m/g, "");
      const pad = " ".repeat(Math.max(0, (widths[i] ?? 0) - visible.length));
      return cell + pad;
    });
    process.stdout.write("  " + padded.join("  ") + "\n");
  }
}
