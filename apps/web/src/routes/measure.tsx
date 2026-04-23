import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api/client.ts";
import { Card, CardBody, CardHeader } from "../components/primitives/Card.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { formatUsd } from "../lib/cn.ts";

export const Route = createFileRoute("/measure")({
  component: MeasurePage,
});

const RANGES = [
  { label: "all-time", value: undefined },
  { label: "30d", value: 30 },
  { label: "7d", value: 7 },
] as const;

function MeasurePage() {
  const [sinceDays, setSinceDays] = useState<number | undefined>(undefined);
  const cac = useQuery({
    queryKey: ["measure", "cac", sinceDays],
    queryFn: () => api.measureCac(sinceDays),
  });
  const rocs = useQuery({
    queryKey: ["measure", "rocs", sinceDays],
    queryFn: () => api.measureRocs(sinceDays),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-zinc-100">Measure</h1>
        <div className="flex items-center gap-2">
          {RANGES.map((r) => (
            <Button
              key={r.label}
              variant={sinceDays === r.value ? "primary" : "secondary"}
              size="sm"
              onClick={() => setSinceDays(r.value)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>CAC by play (signed receipts)</CardHeader>
        <CardBody className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2 text-left font-medium">play</th>
                <th className="px-4 py-2 text-right font-medium">spend</th>
                <th className="px-4 py-2 text-right font-medium">calls</th>
                <th className="px-4 py-2 text-right font-medium">sent</th>
                <th className="px-4 py-2 text-right font-medium">replied</th>
                <th className="px-4 py-2 text-right font-medium">$/send</th>
                <th className="px-4 py-2 text-right font-medium">$/reply</th>
              </tr>
            </thead>
            <tbody>
              {cac.data?.spend.map((s) => {
                const ev = cac.data.events.find((e) => e.playName === s.playName);
                const sent = ev?.sent ?? 0;
                const replied = ev?.replied ?? 0;
                return (
                  <tr key={s.playName} className="border-t border-zinc-800">
                    <td className="px-4 py-2">{s.playName}</td>
                    <td className="px-4 py-2 text-right font-mono">{formatUsd(s.totalUsd)}</td>
                    <td className="px-4 py-2 text-right font-mono text-zinc-400">{s.calls}</td>
                    <td className="px-4 py-2 text-right font-mono text-zinc-400">{sent}</td>
                    <td className="px-4 py-2 text-right font-mono text-zinc-400">{replied}</td>
                    <td className="px-4 py-2 text-right font-mono">
                      {sent > 0 ? formatUsd(s.totalUsd / sent) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-emerald-300">
                      {replied > 0 ? formatUsd(s.totalUsd / replied) : "—"}
                    </td>
                  </tr>
                );
              })}
              {cac.data?.spend.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-zinc-500">
                    No spend in this window. Run a play.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>RoCS — Return on Cognitive Spend (per outcome)</CardHeader>
        <CardBody className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2 text-left font-medium">play</th>
                <th className="px-4 py-2 text-right font-medium">spend</th>
                <th className="px-4 py-2 text-right font-medium">meetings</th>
                <th className="px-4 py-2 text-right font-medium">SQLs</th>
                <th className="px-4 py-2 text-right font-medium">won</th>
                <th className="px-4 py-2 text-right font-medium">$/meeting</th>
                <th className="px-4 py-2 text-right font-medium">$/won</th>
              </tr>
            </thead>
            <tbody>
              {rocs.data?.spend.map((s) => {
                const oc = rocs.data.outcomes.find((o) => o.playName === s.playName);
                const meet = oc?.meetings ?? 0;
                const sql = oc?.sqls ?? 0;
                const won = oc?.won ?? 0;
                return (
                  <tr key={s.playName} className="border-t border-zinc-800">
                    <td className="px-4 py-2">{s.playName}</td>
                    <td className="px-4 py-2 text-right font-mono">{formatUsd(s.totalUsd)}</td>
                    <td className="px-4 py-2 text-right font-mono">{meet}</td>
                    <td className="px-4 py-2 text-right font-mono">{sql}</td>
                    <td className="px-4 py-2 text-right font-mono text-emerald-300">{won}</td>
                    <td className="px-4 py-2 text-right font-mono">
                      {meet > 0 ? formatUsd(s.totalUsd / meet) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-emerald-300">
                      {won > 0 ? formatUsd(s.totalUsd / won) : "—"}
                    </td>
                  </tr>
                );
              })}
              {rocs.data?.spend.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-zinc-500">
                    No spend in this window.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}
