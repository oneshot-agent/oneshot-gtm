import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Play, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { RunPlayEvent, RunPlayRequest } from "@oneshot-gtm/shared-types";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { Card, CardBody, CardHeader } from "../components/primitives/Card.tsx";
import { Checkbox, Field, Input, Textarea } from "../components/primitives/Field.tsx";

export const Route = createFileRoute("/run/$playName")({
  component: RunPage,
});

interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "email" | "number" | "url" | "textarea";
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

interface PlaySchema {
  fields: FieldSpec[];
  defaultRow: Record<string, string>;
  description: string;
  /** Extra non-target options surfaced as form fields above the rows. */
  extras?: FieldSpec[];
}

const PLAY_SCHEMAS: Record<string, PlaySchema> = {
  "show-hn": {
    description:
      "One-touch founder-to-founder reply to a recent Show HN post. References a specific comment thread.",
    fields: [
      { key: "founderName", label: "Founder name", type: "text", required: true },
      { key: "founderEmail", label: "Founder email", type: "email", required: true },
      {
        key: "postTitle",
        label: "Show HN title",
        type: "text",
        required: true,
        placeholder: "Show HN: Acme — open-source durable workflows",
      },
      { key: "postUrl", label: "Show HN URL", type: "url", required: true },
      {
        key: "hookSummary",
        label: "Hook (specific comment thread / detail to reference)",
        type: "textarea",
        required: true,
      },
    ],
    defaultRow: {
      founderName: "",
      founderEmail: "",
      postTitle: "",
      postUrl: "",
      hookSummary: "",
    },
  },
  "job-change": {
    description:
      "Triggered by a prospect starting a new role at a target company. Day-0 only here; cadence engine fires the day-5 follow-up automatically.",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "newRole", label: "New role", type: "text", required: true },
      { key: "newCompany", label: "New company", type: "text", required: true },
      { key: "previousRole", label: "Previous role", type: "text" },
      { key: "previousCompany", label: "Previous company", type: "text" },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      newRole: "",
      newCompany: "",
      previousRole: "",
      previousCompany: "",
      linkedinUrl: "",
    },
  },
  "accelerator-batch": {
    description:
      "Founder-to-founder outreach within or across accelerator batches (YC, On Deck, SPC, Antler, Techstars).",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "cohort",
        label: "Cohort tag",
        type: "text",
        required: true,
        placeholder: "yc-w26",
      },
      { key: "launchUrl", label: "Launch URL (optional)", type: "url" },
      { key: "productOneLiner", label: "Their product one-liner", type: "text" },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      cohort: "",
      launchUrl: "",
      productOneLiner: "",
      linkedinUrl: "",
    },
    extras: [
      {
        key: "senderCohort",
        label: "Your cohort tag (sender)",
        type: "text",
        required: true,
        placeholder: "yc-w23",
      },
      {
        key: "freeForCohortOffer",
        label: "Free-for-cohort offer (optional)",
        type: "text",
        placeholder: "Free for current YC W26 through demo day, just reply with your batch.",
      },
    ],
  },
};

function RunPage() {
  const { playName } = Route.useParams();
  const schema = PLAY_SCHEMAS[playName];

  const [rows, setRows] = useState<Record<string, string>[]>(
    schema ? [{ ...schema.defaultRow }] : [],
  );
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<RunPlayEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const draftedByIndex = useMemo(() => {
    const m = new Map<
      number,
      { subject: string; body: string; flags: string[]; receiptIds?: number[] }
    >();
    for (const e of events) {
      if (e.kind === "draft") {
        m.set(e.index, { subject: e.subject, body: e.body, flags: e.flags });
      } else if (e.kind === "send") {
        const cur = m.get(e.index);
        if (cur) m.set(e.index, { ...cur, receiptIds: e.receiptIds });
      }
    }
    return m;
  }, [events]);

  const doneEvent = events.find((e) => e.kind === "done");
  const errorEvents = events.filter((e) => e.kind === "error");

  if (!schema) {
    return (
      <div className="flex flex-col gap-4">
        <Link
          to="/plays"
          className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
        >
          <ArrowLeft size={14} /> back to plays
        </Link>
        <Card>
          <CardBody>
            <div className="text-sm text-zinc-300">
              Play <code className="font-mono">{playName}</code> isn&apos;t exposed in the dashboard
              yet. Run it from the CLI; the copy-CLI button is on the{" "}
              <Link to="/plays" className="text-zinc-100 underline">
                Plays page
              </Link>
              .
            </div>
          </CardBody>
        </Card>
      </div>
    );
  }

  const updateRow = (rowIdx: number, fieldKey: string, value: string): void => {
    setRows((prev) => {
      const next = prev.slice();
      next[rowIdx] = { ...(next[rowIdx] ?? schema.defaultRow), [fieldKey]: value };
      return next;
    });
  };

  const addRow = (): void => {
    setRows((prev) => [...prev, { ...schema.defaultRow }]);
  };

  const removeRow = (rowIdx: number): void => {
    setRows((prev) => prev.filter((_, i) => i !== rowIdx));
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setEvents([]);
    setRunning(true);

    const targets = rows.map((r) => stripEmpty(r));
    const body: RunPlayRequest = {
      dryRun,
      targets,
      ...(extras["senderCohort"] ? { senderCohort: extras["senderCohort"] } : {}),
      ...(extras["freeForCohortOffer"] ? { freeForCohortOffer: extras["freeForCohortOffer"] } : {}),
    };

    try {
      const res = await fetch(`/api/run/${encodeURIComponent(playName)}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const text = await res.text();
        throw new Error(`${res.status}: ${text.slice(0, 200)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as RunPlayEvent;
            setEvents((prev) => [...prev, ev]);
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/plays"
          className="flex w-fit items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
        >
          <ArrowLeft size={14} /> back to plays
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-100">
          Run <code className="font-mono">{playName}</code>
        </h1>
        <p className="mt-1 text-sm text-zinc-400">{schema.description}</p>
      </div>

      {schema.extras && (
        <Card>
          <CardHeader>Run options</CardHeader>
          <CardBody className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {schema.extras.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint ?? ""}>
                <Input
                  type={f.type === "textarea" ? "text" : f.type}
                  required={!!f.required}
                  placeholder={f.placeholder ?? ""}
                  value={extras[f.key] ?? ""}
                  onChange={(e) => setExtras((s) => ({ ...s, [f.key]: e.target.value }))}
                />
              </Field>
            ))}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <span>Targets ({rows.length})</span>
            <Button variant="secondary" size="sm" onClick={addRow}>
              <Plus size={12} /> add row
            </Button>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-6">
          {rows.map((row, rowIdx) => (
            <div
              // Stable key would require row IDs; rows are short-lived form state, index is acceptable.
              // eslint-disable-next-line react/no-array-index-key
              key={`row-${rowIdx}`}
              className="rounded-md border border-zinc-800 bg-zinc-950/40 p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Target #{rowIdx + 1}
                </span>
                {rows.length > 1 && (
                  <Button variant="ghost" size="sm" onClick={() => removeRow(rowIdx)}>
                    <Trash2 size={12} />
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {schema.fields.map((f) =>
                  f.type === "textarea" ? (
                    <Field
                      key={f.key}
                      label={f.label + (f.required ? " *" : "")}
                      hint={f.hint ?? ""}
                    >
                      <Textarea
                        required={!!f.required}
                        placeholder={f.placeholder ?? ""}
                        value={row[f.key] ?? ""}
                        onChange={(e) => updateRow(rowIdx, f.key, e.target.value)}
                        className="md:col-span-2"
                        rows={3}
                      />
                    </Field>
                  ) : (
                    <Field
                      key={f.key}
                      label={f.label + (f.required ? " *" : "")}
                      hint={f.hint ?? ""}
                    >
                      <Input
                        type={f.type}
                        required={!!f.required}
                        placeholder={f.placeholder ?? ""}
                        value={row[f.key] ?? ""}
                        onChange={(e) => updateRow(rowIdx, f.key, e.target.value)}
                      />
                    </Field>
                  ),
                )}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="flex items-center justify-between gap-4">
        <Checkbox
          label="Dry run (draft only, no send, no spend)"
          checked={dryRun}
          onChange={(e) => setDryRun(e.target.checked)}
        />
        <Button onClick={submit} disabled={running}>
          <Play size={14} />
          {running ? "Running…" : dryRun ? "Generate drafts" : "Send for real"}
        </Button>
      </div>

      {error && (
        <Card>
          <CardBody>
            <Badge tone="red">error</Badge>
            <span className="ml-2 text-sm text-red-300">{error}</span>
          </CardBody>
        </Card>
      )}

      {(events.length > 0 || running) && (
        <Card>
          <CardHeader>Output</CardHeader>
          <CardBody className="flex flex-col gap-4">
            {Array.from(draftedByIndex.entries())
              .toSorted((a, b) => a[0] - b[0])
              .map(([idx, d]) => (
                <div key={idx} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <span className="font-mono text-zinc-500">#{idx + 1}</span>
                    {d.flags.length === 0 && d.receiptIds && <Badge tone="green">sent</Badge>}
                    {d.flags.length === 0 && !d.receiptIds && dryRun && <Badge>dry-run</Badge>}
                    {d.flags.length > 0 && <Badge tone="red">lint</Badge>}
                  </div>
                  <div className="text-sm">
                    <div className="font-mono text-xs text-zinc-400">subject:</div>
                    <div className="mb-2 text-zinc-100">{d.subject}</div>
                    <div className="font-mono text-xs text-zinc-400">body:</div>
                    <pre className="whitespace-pre-wrap font-sans text-zinc-200">{d.body}</pre>
                  </div>
                  {d.flags.length > 0 && (
                    <div className="mt-2 text-xs text-amber-300">
                      {d.flags.map((f) => (
                        <span key={f} className="mr-2 font-mono">
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                  {d.receiptIds && d.receiptIds.length > 0 && (
                    <div className="mt-2 flex items-center gap-2 text-xs">
                      <span className="text-zinc-500">receipts:</span>
                      {d.receiptIds.map((rid) => (
                        <Link
                          key={rid}
                          to="/receipts"
                          className="font-mono text-emerald-400 hover:underline"
                        >
                          #{rid}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            {errorEvents.map((e) =>
              e.kind === "error" ? (
                <div key={`${e.index}-${e.message}`} className="text-xs text-red-300">
                  error: {e.message}
                </div>
              ) : null,
            )}
            {doneEvent && doneEvent.kind === "done" && (
              <div className="text-xs text-zinc-400">
                Done. {doneEvent.sent} of {doneEvent.total} sent.
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function stripEmpty(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v.trim().length > 0) out[k] = v.trim();
  }
  return out;
}
