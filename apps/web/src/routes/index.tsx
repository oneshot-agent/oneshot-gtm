import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, DollarSign, Layers, MailCheck, Send } from "lucide-react";
import { api } from "../api/client.ts";
import { Card, CardBody, CardHeader } from "../components/primitives/Card.tsx";
import { formatUsd, timeAgo } from "../lib/cn.ts";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const home = useQuery({ queryKey: ["home"], queryFn: api.home, refetchInterval: 30_000 });
  const recent = useQuery({
    queryKey: ["receipts", "recent"],
    queryFn: () => api.receipts({ limit: 8 }),
    refetchInterval: 15_000,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-zinc-100">Today</h1>
        <span className="text-xs text-zinc-500">refreshing every 30s</span>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile
          icon={DollarSign}
          label="Spend (7d)"
          value={home.data ? formatUsd(home.data.spendUsd7d) : "—"}
        />
        <Tile
          icon={DollarSign}
          label="Spend (30d)"
          value={home.data ? formatUsd(home.data.spendUsd30d) : "—"}
          dim
        />
        <Tile
          icon={Send}
          label="Sent (7d)"
          value={home.data ? String(home.data.sentLast7d) : "—"}
        />
        <Tile
          icon={MailCheck}
          label="Replied (7d)"
          value={home.data ? String(home.data.repliedLast7d) : "—"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span>Recent receipts</span>
              <Link
                to="/receipts"
                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
              >
                all <ArrowRight size={12} />
              </Link>
            </div>
          </CardHeader>
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-zinc-500">
                  <th className="px-4 py-2 text-left font-medium">id</th>
                  <th className="px-4 py-2 text-left font-medium">play</th>
                  <th className="px-4 py-2 text-left font-medium">type</th>
                  <th className="px-4 py-2 text-right font-medium">cost</th>
                  <th className="px-4 py-2 text-right font-medium">when</th>
                </tr>
              </thead>
              <tbody>
                {recent.data?.receipts.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                    <td className="px-4 py-2 font-mono text-xs text-zinc-500">#{r.id}</td>
                    <td className="px-4 py-2">{r.playName}</td>
                    <td className="px-4 py-2 text-zinc-400">{r.callType}</td>
                    <td className="px-4 py-2 text-right font-mono">
                      {r.costUsd != null ? formatUsd(r.costUsd) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-zinc-500">{timeAgo(r.createdAt)}</td>
                  </tr>
                ))}
                {recent.data?.receipts.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-500">
                      No receipts yet. Run a play from the CLI or the Plays page.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span>In-flight cadences</span>
              <Link
                to="/cadences"
                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
              >
                all <ArrowRight size={12} />
              </Link>
            </div>
          </CardHeader>
          <CardBody>
            <div className="text-3xl font-semibold text-zinc-100">
              {home.data?.activeCadences ?? "—"}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              prospects with at least one active sequence
            </div>
            <div className="mt-4 flex items-center gap-2 text-xs text-zinc-400">
              <Layers size={12} />
              <span>
                Run{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono">cadence advance</code>{" "}
                to fire due steps.
              </span>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  dim,
}: {
  icon: typeof DollarSign;
  label: string;
  value: string;
  dim?: boolean;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-zinc-500">
          <Icon size={12} />
          {label}
        </div>
        <div className={`text-2xl font-semibold ${dim ? "text-zinc-400" : "text-zinc-100"}`}>
          {value}
        </div>
      </CardBody>
    </Card>
  );
}
