import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleStop, Trophy } from "lucide-react";
import { useState } from "react";
import type { OutcomeRequest } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { Card, CardBody, CardHeader } from "../components/primitives/Card.tsx";
import { Field, Input, Select, Textarea } from "../components/primitives/Field.tsx";
import { Modal } from "../components/primitives/Modal.tsx";
import { timeAgo } from "../lib/cn.ts";

export const Route = createFileRoute("/cadences")({
  component: CadencesPage,
});

function statusTone(status: string): "green" | "yellow" | "red" | "neutral" | "blue" {
  switch (status) {
    case "active":
      return "green";
    case "replied":
      return "blue";
    case "breakup":
      return "yellow";
    case "completed":
      return "neutral";
    default:
      return "neutral";
  }
}

interface OutcomeModalState {
  email: string;
  prospectName: string | null;
  playName: string;
}

function CadencesPage() {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [outcomeModal, setOutcomeModal] = useState<OutcomeModalState | null>(null);
  const [outcomeKind, setOutcomeKind] = useState<OutcomeRequest["outcome"]>("meeting_booked");
  const [outcomeAmount, setOutcomeAmount] = useState("");
  const [outcomeNotes, setOutcomeNotes] = useState("");

  const cadences = useQuery({
    queryKey: ["cadences", showAll],
    queryFn: () => api.cadences(showAll),
    refetchInterval: 15_000,
  });

  const stop = useMutation({
    mutationFn: (vars: { prospectId: number; playName: string }) =>
      api.stopCadence(vars.prospectId, vars.playName),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      void qc.invalidateQueries({ queryKey: ["home"] });
    },
  });

  const logOutcome = useMutation({
    mutationFn: async () => {
      if (!outcomeModal) throw new Error("no modal open");
      const req: OutcomeRequest = {
        email: outcomeModal.email,
        outcome: outcomeKind,
        playName: outcomeModal.playName,
        ...(outcomeAmount ? { amountUsd: Number.parseFloat(outcomeAmount) } : {}),
        ...(outcomeNotes ? { notes: outcomeNotes } : {}),
      };
      return await api.recordOutcome(req);
    },
    onSuccess: () => {
      setOutcomeModal(null);
      setOutcomeAmount("");
      setOutcomeNotes("");
      void qc.invalidateQueries({ queryKey: ["measure"] });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-zinc-100">Cadences</h1>
        <div className="flex items-center gap-2">
          <Button
            variant={showAll ? "secondary" : "primary"}
            size="sm"
            onClick={() => setShowAll(false)}
          >
            Active
          </Button>
          <Button
            variant={showAll ? "primary" : "secondary"}
            size="sm"
            onClick={() => setShowAll(true)}
          >
            All
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          {cadences.data
            ? `${cadences.data.cadences.length} ${showAll ? "total" : "active"}`
            : "loading…"}
        </CardHeader>
        <CardBody className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2 text-left font-medium">prospect</th>
                <th className="px-4 py-2 text-left font-medium">play</th>
                <th className="px-4 py-2 text-left font-medium">status</th>
                <th className="px-4 py-2 text-right font-medium">step</th>
                <th className="px-4 py-2 text-right font-medium">next due</th>
                <th className="px-4 py-2 text-right font-medium">enrolled</th>
                <th className="px-4 py-2 text-right font-medium">actions</th>
              </tr>
            </thead>
            <tbody>
              {cadences.data?.cadences.map((c) => (
                <tr
                  key={`${c.prospectId}-${c.playName}`}
                  className="border-t border-zinc-800 hover:bg-zinc-900/40"
                >
                  <td className="px-4 py-2">
                    <div className="text-zinc-100">{c.prospectName ?? "(unknown)"}</div>
                    <div className="font-mono text-xs text-zinc-500">{c.prospectEmail ?? "—"}</div>
                  </td>
                  <td className="px-4 py-2 text-zinc-300">{c.playName}</td>
                  <td className="px-4 py-2">
                    <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{c.currentStep}</td>
                  <td className="px-4 py-2 text-right text-zinc-400">{timeAgo(c.nextDueAt)}</td>
                  <td className="px-4 py-2 text-right text-zinc-500">{timeAgo(c.enrolledAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {c.status === "active" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="stop cadence"
                          disabled={stop.isPending}
                          onClick={() =>
                            stop.mutate({ prospectId: c.prospectId, playName: c.playName })
                          }
                        >
                          <CircleStop size={12} />
                        </Button>
                      )}
                      {c.prospectEmail && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="log outcome"
                          onClick={() =>
                            setOutcomeModal({
                              email: c.prospectEmail as string,
                              prospectName: c.prospectName,
                              playName: c.playName,
                            })
                          }
                        >
                          <Trophy size={12} />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {cadences.data?.cadences.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-zinc-500">
                    No cadences. Send a <code>motion &lt;play&gt;</code> to enroll prospects.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <Modal
        open={outcomeModal != null}
        onClose={() => setOutcomeModal(null)}
        title={`Log outcome${outcomeModal?.prospectName ? ` — ${outcomeModal.prospectName}` : ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOutcomeModal(null)}>
              Cancel
            </Button>
            <Button onClick={() => logOutcome.mutate()} disabled={logOutcome.isPending}>
              {logOutcome.isPending ? "Saving…" : "Save outcome"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="text-xs text-zinc-500">
            Prospect: <span className="text-zinc-300">{outcomeModal?.email}</span>
            <br />
            Play: <span className="text-zinc-300">{outcomeModal?.playName}</span>
          </div>
          <Field label="Outcome">
            <Select
              value={outcomeKind}
              onChange={(e) => setOutcomeKind(e.target.value as OutcomeRequest["outcome"])}
            >
              <option value="meeting_booked">meeting_booked</option>
              <option value="sql_qualified">sql_qualified</option>
              <option value="deal_won">deal_won</option>
              <option value="deal_lost">deal_lost</option>
              <option value="ghosted">ghosted</option>
            </Select>
          </Field>
          {outcomeKind === "deal_won" && (
            <Field label="Amount (USD)">
              <Input
                type="number"
                value={outcomeAmount}
                onChange={(e) => setOutcomeAmount(e.target.value)}
                placeholder="5000"
              />
            </Field>
          )}
          <Field label="Notes (optional)">
            <Textarea
              rows={3}
              value={outcomeNotes}
              onChange={(e) => setOutcomeNotes(e.target.value)}
            />
          </Field>
          {logOutcome.isError && (
            <div className="text-xs text-red-400">{logOutcome.error.message}</div>
          )}
        </div>
      </Modal>
    </div>
  );
}
