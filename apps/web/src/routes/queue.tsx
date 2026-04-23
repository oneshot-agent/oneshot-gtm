import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronRight, Send, X } from "lucide-react";
import { useState } from "react";
import type { QueueRowView, QueueStatusView } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { Card, CardBody, CardHeader } from "../components/primitives/Card.tsx";
import { Field, Input, Textarea } from "../components/primitives/Field.tsx";
import { Modal } from "../components/primitives/Modal.tsx";
import { timeAgo } from "../lib/cn.ts";

export const Route = createFileRoute("/queue")({
  component: QueuePage,
});

const STATUSES: Array<QueueStatusView | "all"> = [
  "all",
  "pending",
  "approved",
  "rejected",
  "sent",
  "expired",
];

const DRAINABLE_PLAYS = [
  "show-hn",
  "job-change",
  "post-funding",
  "accelerator-batch",
  "hiring-signal",
  "podcast-guest",
];

function statusTone(status: QueueStatusView): "green" | "yellow" | "red" | "neutral" | "blue" {
  switch (status) {
    case "pending":
      return "yellow";
    case "approved":
      return "green";
    case "rejected":
      return "red";
    case "sent":
      return "blue";
    case "expired":
      return "neutral";
  }
}

interface RejectModalState {
  id: number;
  email: string;
}

interface DrainModalState {
  playName: string;
  approvedCount: number;
}

function QueuePage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<QueueStatusView | "all">("pending");
  const [playFilter, setPlayFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [rejectModal, setRejectModal] = useState<RejectModalState | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [drainModal, setDrainModal] = useState<DrainModalState | null>(null);
  const [drainLimit, setDrainLimit] = useState(10);
  const [drainSenderCohort, setDrainSenderCohort] = useState("");
  const [drainOffer, setDrainOffer] = useState("");
  const [drainDryRun, setDrainDryRun] = useState(true);

  const queueQuery = useQuery({
    queryKey: ["queue", statusFilter, playFilter],
    queryFn: () =>
      api.queue({
        ...(statusFilter !== "all" ? { status: statusFilter } : {}),
        ...(playFilter !== "all" ? { play: playFilter } : {}),
        limit: 200,
      }),
    refetchInterval: 20_000,
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ["queue"] });
    void qc.invalidateQueries({ queryKey: ["home"] });
  };

  const approve = useMutation({
    mutationFn: (id: number) => api.approveQueue(id),
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: (vars: { id: number; reason?: string }) => api.rejectQueue(vars.id, vars.reason),
    onSuccess: () => {
      setRejectModal(null);
      setRejectReason("");
      invalidate();
    },
  });
  const approveAll = useMutation({
    mutationFn: (play?: string) => api.approveAllQueue(play),
    onSuccess: invalidate,
  });
  const drain = useMutation({
    mutationFn: () => {
      if (!drainModal) throw new Error("no drain modal open");
      return api.drainQueue({
        playName: drainModal.playName,
        limit: drainLimit,
        dryRun: drainDryRun,
        ...(drainSenderCohort ? { senderCohort: drainSenderCohort } : {}),
        ...(drainOffer ? { freeForCohortOffer: drainOffer } : {}),
      });
    },
    onSuccess: () => {
      setDrainModal(null);
      setDrainSenderCohort("");
      setDrainOffer("");
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["receipts"] });
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      void qc.invalidateQueries({ queryKey: ["home"] });
    },
  });

  const counts = queueQuery.data?.counts ?? {
    pending: 0,
    approved: 0,
    rejected: 0,
    sent: 0,
    expired: 0,
  };
  const rows = queueQuery.data?.rows ?? [];

  const playList = Array.from(new Set(rows.map((r) => r.playName))).toSorted();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-zinc-100">Queue</h1>
        <div className="text-xs text-zinc-500">
          {Object.entries(counts)
            .map(([k, v]) => `${k}=${v}`)
            .join("  ·  ")}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-zinc-500">status</span>
        {STATUSES.map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "primary" : "secondary"}
            size="sm"
            onClick={() => setStatusFilter(s)}
          >
            {s}
          </Button>
        ))}
        <span className="ml-4 text-xs uppercase tracking-wider text-zinc-500">play</span>
        <Button
          variant={playFilter === "all" ? "primary" : "secondary"}
          size="sm"
          onClick={() => setPlayFilter("all")}
        >
          all
        </Button>
        {playList.map((p) => (
          <Button
            key={p}
            variant={playFilter === p ? "primary" : "secondary"}
            size="sm"
            onClick={() => setPlayFilter(p)}
          >
            {p}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={approveAll.isPending || counts.pending === 0}
          onClick={() => approveAll.mutate(playFilter === "all" ? undefined : playFilter)}
        >
          <Check size={12} /> approve all pending{playFilter !== "all" ? ` (${playFilter})` : ""}
        </Button>
        {DRAINABLE_PLAYS.map((p) => (
          <Button
            key={p}
            variant="secondary"
            size="sm"
            disabled={
              counts.approved === 0 ||
              (playFilter !== "all" && playFilter !== p) ||
              !rows.some((r) => r.playName === p && r.status === "approved")
            }
            onClick={() =>
              setDrainModal({
                playName: p,
                approvedCount: rows.filter((r) => r.playName === p && r.status === "approved")
                  .length,
              })
            }
          >
            <Send size={12} /> drain {p}
          </Button>
        ))}
      </div>

      <TriggersCard />

      <Card>
        <CardHeader>{queueQuery.data ? `${rows.length} row(s)` : "loading…"}</CardHeader>
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-zinc-500">
              No queue rows match this filter. Run <code>oneshot-gtm find show-hn</code> from the
              CLI to enqueue some.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-zinc-500">
                  <th className="px-4 py-2 text-left font-medium" />
                  <th className="px-4 py-2 text-left font-medium">id</th>
                  <th className="px-4 py-2 text-left font-medium">prospect</th>
                  <th className="px-4 py-2 text-left font-medium">play</th>
                  <th className="px-4 py-2 text-left font-medium">status</th>
                  <th className="px-4 py-2 text-left font-medium">source</th>
                  <th className="px-4 py-2 text-right font-medium">found</th>
                  <th className="px-4 py-2 text-right font-medium">actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <QueueRow
                    key={row.id}
                    row={row}
                    expanded={expanded === row.id}
                    onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                    onApprove={() => approve.mutate(row.id)}
                    onReject={() =>
                      setRejectModal({ id: row.id, email: emailFor(row.payload) ?? `#${row.id}` })
                    }
                    busy={approve.isPending || reject.isPending}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Modal
        open={rejectModal != null}
        onClose={() => setRejectModal(null)}
        title={`Reject #${rejectModal?.id} — ${rejectModal?.email ?? ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejectModal(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                rejectModal &&
                reject.mutate({ id: rejectModal.id, reason: rejectReason || undefined })
              }
              disabled={reject.isPending}
            >
              {reject.isPending ? "Rejecting…" : "Reject"}
            </Button>
          </>
        }
      >
        <Field label="Reason (optional, logged for ICP-filter learning)">
          <Textarea
            rows={3}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="e.g. wrong stage, wrong industry, already a customer"
          />
        </Field>
      </Modal>

      <Modal
        open={drainModal != null}
        onClose={() => setDrainModal(null)}
        title={`Drain ${drainModal?.playName ?? ""} (${drainModal?.approvedCount ?? 0} approved)`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDrainModal(null)}>
              Cancel
            </Button>
            <Button onClick={() => drain.mutate()} disabled={drain.isPending}>
              <Send size={12} />
              {drain.isPending
                ? "Draining…"
                : drainDryRun
                  ? "Preview drain (no send)"
                  : `Send up to ${drainLimit}`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Limit">
            <Input
              type="number"
              min={1}
              value={drainLimit}
              onChange={(e) => setDrainLimit(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
            />
          </Field>
          {drainModal?.playName === "accelerator-batch" && (
            <>
              <Field
                label="Sender cohort (required)"
                hint="Your accelerator/cohort tag, e.g. yc-w23"
              >
                <Input
                  value={drainSenderCohort}
                  onChange={(e) => setDrainSenderCohort(e.target.value)}
                  placeholder="yc-w23"
                  required
                />
              </Field>
              <Field label="Free-for-cohort offer (optional)">
                <Input
                  value={drainOffer}
                  onChange={(e) => setDrainOffer(e.target.value)}
                  placeholder="Free for current YC W26 through demo day, just reply with your batch."
                />
              </Field>
            </>
          )}
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
              checked={drainDryRun}
              onChange={(e) => setDrainDryRun(e.target.checked)}
            />
            Dry-run (preview drafts, no send, no spend)
          </label>
          {drain.isError && <div className="text-xs text-red-400">{drain.error.message}</div>}
          {drain.data && (
            <div className="text-xs text-emerald-300">
              {drainDryRun
                ? `Would send ${drain.data.sent} of ${drain.data.drained}.`
                : `Sent ${drain.data.sent} of ${drain.data.drained}.`}
              {drain.data.errors.length > 0 && (
                <div className="mt-1 text-red-400">
                  {drain.data.errors.length} error(s):{" "}
                  {drain.data.errors.map((e) => e.message).join(" · ")}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function QueueRow({
  row,
  expanded,
  onToggle,
  onApprove,
  onReject,
  busy,
}: {
  row: QueueRowView;
  expanded: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const email = emailFor(row.payload);
  const name = nameFor(row.payload);
  const company = companyFor(row.payload);
  return (
    <>
      <tr
        className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900/40"
        onClick={onToggle}
      >
        <td className="px-4 py-2 text-zinc-500">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </td>
        <td className="px-4 py-2 font-mono text-xs text-zinc-500">#{row.id}</td>
        <td className="px-4 py-2">
          <div className="text-zinc-100">{name ?? "(unknown)"}</div>
          <div className="font-mono text-xs text-zinc-500">
            {email ?? "—"}
            {company ? ` · ${company}` : ""}
          </div>
        </td>
        <td className="px-4 py-2 text-zinc-300">{row.playName}</td>
        <td className="px-4 py-2">
          <Badge tone={statusTone(row.status)}>{row.status}</Badge>
        </td>
        <td className="px-4 py-2 font-mono text-xs text-zinc-500">{row.source}</td>
        <td className="px-4 py-2 text-right text-zinc-500">{timeAgo(row.foundAt)}</td>
        <td className="px-4 py-2 text-right" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-1">
            {row.status === "pending" && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  title="approve"
                  disabled={busy}
                  onClick={onApprove}
                >
                  <Check size={12} />
                </Button>
                <Button variant="ghost" size="sm" title="reject" disabled={busy} onClick={onReject}>
                  <X size={12} />
                </Button>
              </>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-zinc-800 bg-zinc-950/40">
          <td colSpan={8} className="px-4 py-3">
            <div className="text-xs text-zinc-500">
              {row.notes ? <div className="mb-2 italic">{row.notes}</div> : null}
              <pre className="max-h-[300px] overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
                {JSON.stringify(row.payload, null, 2)}
              </pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function TriggersCard() {
  const qc = useQueryClient();
  const triggersQuery = useQuery({
    queryKey: ["triggers"],
    queryFn: () => api.triggers(),
    refetchInterval: 30_000,
  });
  const setEnabled = useMutation({
    mutationFn: (vars: { name: string; enabled: boolean }) =>
      api.setTriggerEnabled(vars.name, vars.enabled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["triggers"] }),
  });
  const setConfig = useMutation({
    mutationFn: (vars: { name: string; config: unknown }) =>
      api.setTriggerConfig(vars.name, vars.config),
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["triggers"] });
    },
  });

  const [editing, setEditing] = useState<{ name: string; text: string } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const triggers = triggersQuery.data?.triggers ?? [];

  return (
    <Card>
      <CardHeader>Triggers ({triggers.length})</CardHeader>
      <CardBody className="p-0">
        {triggers.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-zinc-500">
            No triggers registered. Run <code>oneshot-gtm find watch --once</code> to bootstrap.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2 text-left font-medium">name</th>
                <th className="px-4 py-2 text-left font-medium">enabled</th>
                <th className="px-4 py-2 text-left font-medium">interval</th>
                <th className="px-4 py-2 text-left font-medium">last polled</th>
                <th className="px-4 py-2 text-left font-medium">last run</th>
                <th className="px-4 py-2 text-right font-medium">actions</th>
              </tr>
            </thead>
            <tbody>
              {triggers.map((t) => {
                const summary = summarizeRun(t.lastRunSummary);
                return (
                  <tr key={t.name} className="border-t border-zinc-800">
                    <td className="px-4 py-2 font-mono text-xs text-zinc-200">{t.name}</td>
                    <td className="px-4 py-2">
                      <label className="flex items-center gap-2 text-xs text-zinc-400">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                          checked={t.enabled}
                          disabled={setEnabled.isPending}
                          onChange={(e) =>
                            setEnabled.mutate({ name: t.name, enabled: e.target.checked })
                          }
                        />
                        {t.enabled ? "on" : "off"}
                      </label>
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-400">
                      {humanInterval(t.defaultIntervalMs)}
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-400">
                      {t.lastPolledAt ? timeAgo(t.lastPolledAt) : "never"}
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-400">{summary}</td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing({ name: t.name, text: JSON.stringify(t.config ?? {}, null, 2) });
                          setEditError(null);
                        }}
                      >
                        edit config
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardBody>

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        title={`Config for ${editing?.name ?? ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!editing) return;
                let parsed: unknown;
                try {
                  parsed = JSON.parse(editing.text);
                } catch (err) {
                  setEditError(`Invalid JSON: ${(err as Error).message}`);
                  return;
                }
                if (!parsed || typeof parsed !== "object") {
                  setEditError("Config must be a JSON object.");
                  return;
                }
                setEditError(null);
                setConfig.mutate({ name: editing.name, config: parsed });
              }}
              disabled={setConfig.isPending}
            >
              {setConfig.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <Field label="JSON config">
          <Textarea
            rows={10}
            value={editing?.text ?? ""}
            onChange={(e) => setEditing(editing ? { ...editing, text: e.target.value } : null)}
            className="font-mono text-xs"
          />
        </Field>
        {editError && <div className="mt-2 text-xs text-red-400">{editError}</div>}
      </Modal>
    </Card>
  );
}

function summarizeRun(summary: unknown): string {
  if (!summary || typeof summary !== "object") return "—";
  const s = summary as Record<string, unknown>;
  if (typeof s["error"] === "string") return `error: ${(s["error"] as string).slice(0, 60)}`;
  const parts: string[] = [];
  if (typeof s["candidates"] === "number") parts.push(`cand=${s["candidates"]}`);
  if (typeof s["enqueued"] === "number") parts.push(`kept=${s["enqueued"]}`);
  if (typeof s["droppedIcp"] === "number") parts.push(`icp=${s["droppedIcp"]}`);
  if (typeof s["costUsd"] === "number") {
    parts.push(`$${(s["costUsd"] as number).toFixed(2)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function humanInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

function emailFor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["email"] === "string") return p["email"] as string;
  if (typeof p["founderEmail"] === "string") return p["founderEmail"] as string;
  return null;
}

function nameFor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["name"] === "string") return p["name"] as string;
  if (typeof p["founderName"] === "string") return p["founderName"] as string;
  return null;
}

function companyFor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["company"] === "string") return p["company"] as string;
  return null;
}
