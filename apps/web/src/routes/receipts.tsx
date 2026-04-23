import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { X } from "lucide-react";
import { api } from "../api/client.ts";
import { Card, CardBody, CardHeader } from "../components/primitives/Card.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { formatUsd, timeAgo } from "../lib/cn.ts";

export const Route = createFileRoute("/receipts")({
  component: ReceiptsPage,
});

function ReceiptsPage() {
  const [activeId, setActiveId] = useState<number | null>(null);
  const receipts = useQuery({
    queryKey: ["receipts", "list"],
    queryFn: () => api.receipts({ limit: 200 }),
    refetchInterval: 20_000,
  });
  const detail = useQuery({
    queryKey: ["receipts", "detail", activeId],
    queryFn: () => (activeId == null ? Promise.resolve(null) : api.receipt(activeId)),
    enabled: activeId != null,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-zinc-100">Receipts</h1>
        <span className="text-xs text-zinc-500">
          {receipts.data ? `${receipts.data.receipts.length} shown` : "loading…"}
        </span>
      </div>

      <Card>
        <CardHeader>signed receipts (most recent first)</CardHeader>
        <CardBody className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2 text-left font-medium">id</th>
                <th className="px-4 py-2 text-left font-medium">play</th>
                <th className="px-4 py-2 text-left font-medium">type</th>
                <th className="px-4 py-2 text-right font-medium">cost</th>
                <th className="px-4 py-2 text-right font-medium">when</th>
                <th className="px-4 py-2 text-right font-medium">request id</th>
              </tr>
            </thead>
            <tbody>
              {receipts.data?.receipts.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setActiveId(r.id)}
                  className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900/40"
                >
                  <td className="px-4 py-2 font-mono text-xs text-zinc-500">#{r.id}</td>
                  <td className="px-4 py-2">{r.playName}</td>
                  <td className="px-4 py-2 text-zinc-400">{r.callType}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {r.costUsd != null ? formatUsd(r.costUsd) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-zinc-500">{timeAgo(r.createdAt)}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-zinc-500">
                    {r.oneshotRequestId ?? "—"}
                  </td>
                </tr>
              ))}
              {receipts.data?.receipts.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-zinc-500">
                    No receipts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {activeId != null && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-zinc-950/70 backdrop-blur"
          onClick={() => setActiveId(null)}
        >
          <div
            className="max-h-[80vh] w-[min(720px,92vw)] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div className="text-sm">
                <span className="font-mono text-zinc-500">#{activeId}</span>{" "}
                <span className="text-zinc-300">
                  {detail.data?.receipt.playName} · {detail.data?.receipt.callType}
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setActiveId(null)}>
                <X size={14} />
              </Button>
            </div>
            <div className="p-4">
              <pre className="max-h-[60vh] overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
                {detail.isLoading
                  ? "loading…"
                  : JSON.stringify(detail.data?.receipt.signedReceipt ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
