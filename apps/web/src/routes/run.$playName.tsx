import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Loader2, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RunPlayEvent, RunPlayRequest, RunRecord } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { Field, Input, Textarea } from "../components/primitives/Field.tsx";
import { cn } from "../lib/cn.ts";
import { useMask } from "../lib/privacy.tsx";
import { pruneSentRows } from "../lib/pruneSentRows.ts";

/**
 * Search-param contract for arrivals from the `/queue` drain modal.
 * `fromQueue=1` triggers a one-time fetch of approved rows for this play
 * which then hydrates the targets editor. The other params round-trip the
 * modal's collected fields so the founder can submit from /run as if they
 * never left /queue.
 */
interface RunSearch {
  fromQueue?: "1";
  limit?: number;
  dryRun?: "0" | "1";
  senderCohort?: string;
  freeForCohortOffer?: string;
  /**
   * When set, the page is in progress / done / interrupted mode. The page
   * fetches GET /api/runs/:runId and renders the per-target state read from
   * the server, polling every 2s while status === 'running'. Survives
   * navigate-away-and-back; on cold-boot sweep it shows as 'interrupted'.
   */
  runId?: number;
}

export const Route = createFileRoute("/run/$playName")({
  component: RunPage,
  validateSearch: (search: Record<string, unknown>): RunSearch => {
    const out: RunSearch = {};
    if (search["fromQueue"] === "1") out.fromQueue = "1";
    if (typeof search["limit"] === "number") out.limit = search["limit"];
    else if (typeof search["limit"] === "string" && /^\d+$/.test(search["limit"])) {
      out.limit = Number.parseInt(search["limit"], 10);
    }
    if (search["dryRun"] === "0" || search["dryRun"] === "1") out.dryRun = search["dryRun"];
    if (typeof search["senderCohort"] === "string") out.senderCohort = search["senderCohort"];
    if (typeof search["freeForCohortOffer"] === "string") {
      out.freeForCohortOffer = search["freeForCohortOffer"];
    }
    if (typeof search["runId"] === "number") out.runId = search["runId"];
    else if (typeof search["runId"] === "string" && /^\d+$/.test(search["runId"])) {
      out.runId = Number.parseInt(search["runId"], 10);
    }
    return out;
  },
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
        placeholder: "e.g. yc-w26 · tx-s26 · antler-ldn-12",
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
        placeholder: "e.g. yc-w23 · od-2 · (leave blank)",
      },
      {
        key: "freeForCohortOffer",
        label: "Free-for-cohort offer (optional)",
        type: "text",
        placeholder: "e.g. Free for your batch through demo day — reply with your cohort.",
      },
    ],
  },
  "post-funding": {
    description:
      "Triggered by a recent funding announcement. Day-0 here; cadence engine fires the day-9 follow-up and day-18 breakup automatically.",
    fields: [
      { key: "name", label: "Founder name", type: "text", required: true },
      { key: "email", label: "Founder email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "round",
        label: "Round",
        type: "text",
        required: true,
        placeholder: "Seed / Series A / Series B",
      },
      {
        key: "amountUsd",
        label: "Amount (USD)",
        type: "number",
        required: true,
        placeholder: "5000000",
      },
      { key: "leadInvestor", label: "Lead investor (optional)", type: "text" },
      { key: "sourceUrl", label: "Announcement URL", type: "url", required: true },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      round: "",
      amountUsd: "",
      leadInvestor: "",
      sourceUrl: "",
      linkedinUrl: "",
    },
  },
  "hiring-signal": {
    description:
      "Triggered by a job post at a target company. One-touch email to the hiring manager with your ramp-time claim.",
    fields: [
      { key: "name", label: "Hiring manager name", type: "text", required: true },
      { key: "email", label: "Hiring manager email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      { key: "jobTitle", label: "Job title they're hiring for", type: "text", required: true },
      { key: "jobPostUrl", label: "Job post URL (optional)", type: "url" },
      {
        key: "yourClaim",
        label: "Your ramp-time claim",
        type: "textarea",
        required: true,
        placeholder:
          "We cut new-hire ramp time by ~30% on the team they're hiring for — happy to share how.",
      },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      jobTitle: "",
      jobPostUrl: "",
      yourClaim: "",
    },
  },
  "podcast-guest": {
    description:
      "One-touch reply to a recent podcast guest referencing a specific moment from the episode.",
    fields: [
      { key: "name", label: "Guest name", type: "text", required: true },
      { key: "email", label: "Guest email", type: "email", required: true },
      { key: "company", label: "Guest company", type: "text", required: true },
      {
        key: "podcast",
        label: "Podcast",
        type: "text",
        required: true,
        placeholder: "Latent Space",
      },
      { key: "episodeTitle", label: "Episode title", type: "text", required: true },
      {
        key: "hookQuote",
        label: "Specific quote or moment",
        type: "textarea",
        required: true,
      },
      {
        key: "bridge",
        label: "Why the moment matters to your work (one sentence)",
        type: "text",
      },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      podcast: "",
      episodeTitle: "",
      hookQuote: "",
      bridge: "",
    },
  },
  "competitor-switch": {
    description:
      "Migration-honesty pitch to a prospect using a vendor you replace. Cites a specific evidence URL or claim, includes one yourEdge fact.",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "competitor",
        label: "Competitor (incumbent)",
        type: "text",
        required: true,
        placeholder: "e.g. Salesforce · QuickBooks · Mailchimp",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "One specific advantage, not a feature list. e.g. 'setup takes an afternoon, not a quarter'.",
      },
      {
        key: "evidenceUrl",
        label: "Evidence URL (optional)",
        type: "url",
        placeholder: "https://...",
      },
      {
        key: "evidenceText",
        label: "Evidence text (optional — paste a quote/snippet)",
        type: "textarea",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      competitor: "",
      yourEdge: "",
      evidenceUrl: "",
      evidenceText: "",
      linkedinUrl: "",
    },
  },
  "stack-consolidation": {
    description:
      "Consolidation-honesty pitch to a developer whose repo wires up several separate API vendors. One SDK collapses the sprawl; cites the detected stack and one yourEdge fact.",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "vendorStack",
        label: "Vendor stack (comma-separated)",
        type: "textarea",
        required: true,
        placeholder: "e.g. auth0, stripe, sendgrid, datadog",
        hint: "API vendors detected in their repo. Comma-separated.",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "One specific way you collapse the sprawl. e.g. 'one integration replaces three separate vendors'.",
      },
      {
        key: "evidenceUrl",
        label: "Repo URL (optional)",
        type: "url",
        placeholder: "https://github.com/...",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      vendorStack: "",
      yourEdge: "",
      evidenceUrl: "",
      linkedinUrl: "",
    },
  },
  "repo-interest": {
    description:
      "Complementary intro to someone who starred a repo in your space (an adjacent tool, not a competitor). References the repo + one fact about how your product helps. One touch, no follow-up.",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "repo",
        label: "Repo they starred (owner/name)",
        type: "text",
        required: true,
        placeholder: "e.g. modelcontextprotocol/servers",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "How your product helps someone working in this space. e.g. 'one SDK for the tools they're already wiring up'.",
      },
      {
        key: "evidenceUrl",
        label: "Repo URL (optional)",
        type: "url",
        placeholder: "https://github.com/...",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      repo: "",
      yourEdge: "",
      evidenceUrl: "",
      linkedinUrl: "",
    },
  },
  "luma-events": {
    description:
      "Forward-looking pitch to a publicly-visible attendee of an upcoming Luma event. Hook references the specific event + city + date. One touch, no follow-up.",
    fields: [
      { key: "name", label: "Attendee name", type: "text", required: true },
      { key: "email", label: "Attendee email", type: "email", required: true },
      { key: "company", label: "Company (optional)", type: "text" },
      {
        key: "attendeeBio",
        label: "Attendee bio / role (optional)",
        type: "text",
        placeholder: 'e.g. "Founder @ AcmeAI"',
      },
      {
        key: "eventTitle",
        label: "Event title",
        type: "text",
        required: true,
        placeholder: "e.g. SF AI Builders Meetup",
      },
      {
        key: "eventDate",
        label: "Event date (ISO)",
        type: "text",
        required: true,
        placeholder: "2026-06-10",
        hint: "ISO date or datetime; prompt humanizes to 'tomorrow' / 'next Tuesday'.",
      },
      {
        key: "eventCity",
        label: "Event city",
        type: "text",
        required: true,
        placeholder: "San Francisco",
      },
      {
        key: "eventUrl",
        label: "Luma event URL",
        type: "url",
        required: true,
        placeholder: "https://luma.com/...",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "How your product helps people going to events like this. e.g. 'a teardown of how X handles Y for hosts/attendees'.",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      attendeeBio: "",
      eventTitle: "",
      eventDate: "",
      eventCity: "",
      eventUrl: "",
      yourEdge: "",
      linkedinUrl: "",
    },
  },
};

function RunPage() {
  const { playName } = Route.useParams();
  const search = Route.useSearch();
  const schema = PLAY_SCHEMAS[playName];
  const mask = useMask();

  const [rows, setRows] = useState<Record<string, string>[]>(
    schema ? [{ ...schema.defaultRow }] : [],
  );
  // Parallel to `rows`: each entry is the originating queue row's dedupeKey
  // (when hydrated from `?fromQueue=1`) or null (manual entry / added row).
  // The server uses these to persist drafts back to the matching queue row;
  // null entries get skipped (correct — there's nothing to update).
  const [dedupeKeys, setDedupeKeys] = useState<(string | null)[]>(schema ? [null] : []);
  const [extras, setExtras] = useState<Record<string, string>>({});
  // dryRun mirrors what the founder picked in the drain modal when arriving
  // via `?fromQueue=1`. Default true otherwise — manual /run entry is more
  // commonly a preview than a real send.
  const [dryRun, setDryRun] = useState(search.dryRun !== "0");
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<RunPlayEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = Route.useNavigate();
  // Cross-route navigation (e.g. to /cadences for the deep-link from done mode).
  const globalNavigate = useNavigate();

  // Run state machine: edit | progress | done | interrupted. Driven by
  // `search.runId`. When set, we fetch GET /api/runs/:id and re-render the
  // per-target view from server-persisted events — so the page is fully
  // resumable across nav-away-and-back AND across server restarts (the
  // cold-boot sweep flips stranded runs to 'interrupted').
  const runQuery = useQuery({
    queryKey: ["run", search.runId],
    queryFn: () => (search.runId ? api.run(search.runId) : Promise.resolve(null)),
    enabled: search.runId != null,
    refetchInterval: (q): false | number => {
      const data = q.state.data as RunRecord | null | undefined;
      return data && data.status === "running" ? 2000 : false;
    },
  });
  const runRecord: RunRecord | null = (runQuery.data as RunRecord | null | undefined) ?? null;
  // A 404 from /api/runs/:id (run was deleted, or the URL was hand-edited
  // with a bad id) shouldn't pin the page on "progress" forever — flag the
  // missing-id case so the page can recover to edit mode.
  const runNotFound =
    search.runId != null &&
    runQuery.isError &&
    /\b404\b/.test((runQuery.error as Error | null)?.message ?? "");
  const mode: "edit" | "progress" | "done" | "interrupted" =
    search.runId == null || runNotFound
      ? "edit"
      : runRecord == null
        ? "progress" // still loading
        : runRecord.status === "running"
          ? "progress"
          : runRecord.status === "interrupted"
            ? "interrupted"
            : "done";
  // When the server-persisted record arrives, mirror its events into the
  // local stream array so the existing per-target rendering keeps working
  // unmodified. Local SSE writes still hit setEvents during a live submit;
  // when search.runId flips on, this overrides with the durable copy.
  useEffect(() => {
    if (runRecord) {
      setEvents(runRecord.events);
    }
  }, [runRecord]);
  // Set when navigated from /queue with fromQueue=1 AND the approved-rows
  // fetch returned zero. Surfaces a one-line empty-state hint so the
  // founder isn't confused by the schema's default empty row.
  const [hydrationEmpty, setHydrationEmpty] = useState(false);

  // Mount-only hydrate-from-queue.
  //
  // StrictMode (dev) double-invokes this effect; we use a closure-scoped
  // `cancelled` flag so the first invocation's fetch resolves into a no-op
  // and the second invocation's fetch is the one that updates state. A
  // `useRef`-based "ran-once" guard would persist across the remount and
  // make the SECOND invocation skip — leaving state un-hydrated even though
  // we ran a fetch (silent dev-only failure).
  //
  // Net cost: 1 extra GET in dev StrictMode; 1 GET total in production.
  const hydrateFromQueue = useCallback(
    async (cancelledRef?: { cancelled: boolean }): Promise<void> => {
      if (!schema) return;
      try {
        const res = await api.queue({
          play: playName,
          status: "approved",
          limit: search.limit ?? 50,
        });
        if (cancelledRef?.cancelled) return;
        const pairs = res.rows
          .map((r) => ({ payload: r.payload, dedupeKey: r.dedupeKey }))
          .filter((p): p is { payload: Record<string, unknown>; dedupeKey: string } => {
            return Boolean(p.payload) && typeof p.payload === "object";
          });
        const targets = pairs.map(({ payload }) => {
          const out: Record<string, string> = Object.assign({}, schema.defaultRow);
          for (const k of Object.keys(payload)) {
            const v = payload[k];
            out[k] = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
          }
          return out;
        });
        if (targets.length === 0) {
          setHydrationEmpty(true);
          setRows([{ ...schema.defaultRow }]);
          setDedupeKeys([null]);
          return;
        }
        setHydrationEmpty(false);
        setRows(targets);
        setDedupeKeys(pairs.map((p) => p.dedupeKey));
        // Reflect any per-row extras the finder stamped (e.g. accelerator-batch's
        // senderCohort) in the form's extras, so the field shows the value that
        // will actually be used instead of sitting empty. prev wins, so a value
        // the founder typed (or the drain modal passed) is never clobbered.
        const stampedString = (key: string): string | undefined => {
          for (const { payload } of pairs) {
            const v = payload[key];
            if (typeof v === "string" && v.trim().length > 0) return v;
          }
          return undefined;
        };
        const stamped: Record<string, string> = {};
        for (const key of ["senderCohort", "freeForCohortOffer"]) {
          const v = stampedString(key);
          if (v) stamped[key] = v;
        }
        if (Object.keys(stamped).length > 0) {
          setExtras((prev) => ({ ...stamped, ...prev }));
        }
      } catch (err) {
        if (cancelledRef?.cancelled) return;
        setError(`failed to load approved targets from queue: ${(err as Error).message}`);
      }
    },
    [playName, schema, search.limit],
  );

  useEffect(() => {
    if (search.fromQueue !== "1") return;
    const ref = { cancelled: false };
    void (async () => {
      await hydrateFromQueue(ref);
      if (ref.cancelled) return;
      // Round-trip the modal's per-play extras (accelerator-batch only
      // today) so the founder doesn't have to retype senderCohort/offer.
      const ex: Record<string, string> = {};
      if (search.senderCohort) ex["senderCohort"] = search.senderCohort;
      if (search.freeForCohortOffer) ex["freeForCohortOffer"] = search.freeForCohortOffer;
      if (Object.keys(ex).length > 0) setExtras((prev) => ({ ...prev, ...ex }));
    })();
    return () => {
      ref.cancelled = true;
    };
    // Mount-only on purpose — re-running on search-param edits would clobber
    // founder edits to the loaded rows. The manual "Refresh from queue"
    // button invokes hydrateFromQueue directly on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const verifyEvent = events.find((e) => e.kind === "verify");
  // Latest pipeline stage ("verifying" / "drafting + sending"), shown while the
  // run is in flight so it doesn't read as frozen on a slow real send.
  const latestStage = events.findLast((e) => e.kind === "stage");

  const aggregate = useMemo(() => {
    const drafts = draftedByIndex.size;
    let sent = 0;
    let flagged = 0;
    for (const d of draftedByIndex.values()) {
      if (d.receiptIds && d.receiptIds.length > 0) sent++;
      if (d.flags.length > 0) flagged++;
    }
    return { drafts, sent, flagged };
  }, [draftedByIndex]);

  if (!schema) {
    return (
      <div className="-mx-6 -my-6 flex flex-col">
        <section className="border-b border-ink-rule px-6 pb-5 pt-6">
          <Link
            to="/plays"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-muted hover:text-ink-cream"
          >
            <ArrowLeft size={11} /> back to plays
          </Link>
          <div className="ln-eyebrow mt-3">The Ledger · Run</div>
          <h1
            className="mt-1 text-ink-cream"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 36,
              fontWeight: 400,
              letterSpacing: "-0.02em",
              lineHeight: 1,
            }}
          >
            CLI-only play.
          </h1>
          <p className="ln-note mt-3 max-w-[64ch] text-[14px] text-ink-cream-2">
            <code className="font-mono text-[color:var(--ink-spend-2)]">{playName}</code> isn&apos;t
            exposed in the dashboard yet. Run it from the CLI; the copy-CLI button is on the{" "}
            <Link
              to="/plays"
              className="text-ink-cream underline decoration-ink-faint decoration-1 underline-offset-2"
            >
              Plays page
            </Link>
            .
          </p>
        </section>
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
    // New rows have no queue origin → null in the parallel array. Keeps
    // indices aligned so server-side persistence skips them cleanly.
    setDedupeKeys((prev) => [...prev, null]);
  };

  const removeRow = (rowIdx: number): void => {
    setRows((prev) => prev.filter((_, i) => i !== rowIdx));
    setDedupeKeys((prev) => prev.filter((_, i) => i !== rowIdx));
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setEvents([]);
    setRunning(true);

    // Snapshot rows/dedupeKeys at submit time so the post-run auto-prune
    // can reconcile by original index even though the form is disabled
    // during the run (state can't drift here, but the closure capture is
    // explicit and avoids any future foot-gun).
    const rowsSnapshot = rows;
    const dedupeKeysSnapshot = dedupeKeys;

    const targets = rows.map((r) => stripEmpty(r));
    // Only attach dedupeKeys when at least one row has one (i.e. arrived
    // from /queue). Pure-manual sessions skip the field; the server then
    // skips persistence entirely.
    const hasAnyDedupeKey = dedupeKeys.some((k) => k != null);
    const body: RunPlayRequest = {
      dryRun,
      targets,
      ...(hasAnyDedupeKey ? { dedupeKeys } : {}),
      ...(extras["senderCohort"] ? { senderCohort: extras["senderCohort"] } : {}),
      ...(extras["freeForCohortOffer"] ? { freeForCohortOffer: extras["freeForCohortOffer"] } : {}),
    };

    // Local mirror of the SSE event stream — avoids reading React state in
    // the finally block (which would be stale due to async update batching)
    // and keeps setState calls below pure (one setter per concern).
    const streamedEvents: RunPlayEvent[] = [];

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
            streamedEvents.push(ev);
            setEvents((prev) => [...prev, ev]);
            // First frame is always { kind: "runStarted", runId }. Navigate
            // to the same page with `?runId=N` so the page is now in
            // progress mode AND survives nav-away (the URL is the durable
            // handle). The SSE stream keeps feeding `setEvents` for instant
            // updates; `runQuery` takes over once the user returns later.
            if (ev.kind === "runStarted") {
              void navigate({ search: (prev) => ({ ...prev, runId: ev.runId }) });
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
      // After a real-send run, drop rows whose draft actually shipped so
      // they can't be resent by a second submission of the same form.
      // Held / errored / unsent rows stay so the founder can edit and retry.
      const pruned = pruneSentRows(streamedEvents, rowsSnapshot, dedupeKeysSnapshot);
      if (pruned.prunedCount > 0) {
        setRows(pruned.rows);
        setDedupeKeys(pruned.dedupeKeys);
        // The per-index draft/send details from the just-finished run no
        // longer line up with the surviving rows — clear so the UI doesn't
        // show stale previews under freshly-shifted indices.
        setEvents([]);
      }
    }
  };

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      {/* Masthead */}
      <section className="border-b border-ink-rule px-6 pb-5 pt-6">
        <Link
          to="/plays"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-muted hover:text-ink-cream"
        >
          <ArrowLeft size={11} /> back to plays
        </Link>
        <div className="mt-3 flex items-baseline gap-3">
          <div className="ln-eyebrow">The Ledger · Run</div>
          <code
            className="font-mono text-[13px] text-[color:var(--ink-spend-2)]"
            style={{ fontFeatureSettings: '"zero"' }}
          >
            {playName}
          </code>
          {search.fromQueue === "1" && (
            <button
              type="button"
              onClick={() => void hydrateFromQueue()}
              disabled={running}
              title="Re-load approved rows from the queue (drops your in-form edits)"
              className="ml-2 inline-flex items-center gap-1 font-mono text-[11px] text-ink-muted hover:text-ink-cream disabled:opacity-40"
            >
              <RefreshCw size={11} /> refresh from queue
            </button>
          )}
        </div>
        <h1
          className="mt-1 text-ink-cream"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 44,
            fontWeight: 600,
            letterSpacing: "-0.025em",
            lineHeight: 0.98,
          }}
        >
          Draft in dry-run, then send.
        </h1>
        <p className="ln-note mt-3 max-w-[72ch] text-[14px] text-ink-cream-2">
          {schema.description}
        </p>
        {hydrationEmpty && (
          <p className="mt-3 font-mono text-[12px] text-ink-spend-2">
            no approved targets in <code>{playName}</code> queue right now — add rows below or
            approve some on the{" "}
            <Link to="/queue" className="underline decoration-ink-faint underline-offset-2">
              queue page
            </Link>
            .
          </p>
        )}
        {mode === "progress" && runRecord && (
          <p className="mt-3 font-mono text-[12px] text-ink-cream-2">
            Run #{runRecord.id} · {runRecord.draftedCount}/{runRecord.targetCount} drafted ·{" "}
            {runRecord.sentCount} sent · {runRecord.errorCount} errors · in progress
          </p>
        )}
        {mode === "done" && runRecord && (
          <p className="mt-3 font-mono text-[12px] text-ink-cream-2">
            Run #{runRecord.id} complete · {runRecord.sentCount} of {runRecord.targetCount} sent ·{" "}
            {runRecord.errorCount} errors
          </p>
        )}
        {mode === "interrupted" && runRecord && (
          <div className="mt-3 rounded-[var(--radius-sm)] border border-[color:var(--ink-blocked-2)] bg-[color:var(--ink-blocked-2)]/10 px-3 py-2 font-mono text-[12px] text-[color:var(--ink-blocked-2)]">
            Run #{runRecord.id} was interrupted by a server restart. {runRecord.sentCount} of{" "}
            {runRecord.targetCount} drafted before the kill. Click <em>Run again</em> below to
            re-fire the remaining targets — already-sent emails won't fire twice (per-prospect
            step-0 dedupe).
          </div>
        )}
      </section>

      {schema.extras && (
        <RunLedgerSection eyebrow="Run options">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
          </div>
        </RunLedgerSection>
      )}

      <RunLedgerSection
        eyebrow={`Targets · ${rows.length}`}
        action={
          <Button variant="secondary" size="sm" onClick={addRow}>
            <Plus size={12} /> add row
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          {rows.map((row, rowIdx) => (
            <div
              // eslint-disable-next-line react/no-array-index-key
              key={`row-${rowIdx}`}
              className="border-l-2 border-ink-rule pl-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="font-mono text-[11px] text-ink-faint">target #{rowIdx + 1}</span>
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
                      className="md:col-span-2"
                    >
                      <Textarea
                        required={!!f.required}
                        placeholder={f.placeholder ?? ""}
                        value={row[f.key] ?? ""}
                        onChange={(e) => updateRow(rowIdx, f.key, e.target.value)}
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
        </div>
      </RunLedgerSection>

      {/* Action bar — sticky. The visible controls + label depend on `mode`. */}
      <section className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-t border-ink-rule bg-ink-bg/90 px-6 py-3 backdrop-blur-[2px]">
        {mode === "edit" && (
          <button
            type="button"
            onClick={() => setDryRun((d) => !d)}
            className={cn(
              "font-mono text-[11px] uppercase tracking-[0.14em] rounded-[var(--radius-sm)] border px-2.5 py-1 transition-colors",
              dryRun
                ? "border-ink-rule text-ink-muted hover:text-ink-cream-2"
                : "border-[color:var(--ink-spend-2)] text-[color:var(--ink-spend-2)] hover:bg-[color:var(--ink-spend-2)]/10",
            )}
            title={
              dryRun
                ? "MODE: DRY RUN — drafts only, no SDK send. Click to switch to real send."
                : "MODE: SEND FOR REAL — every drafted row will leave the inbox. Click to switch to dry run."
            }
          >
            {dryRun ? "MODE: DRY RUN" : "MODE: SEND FOR REAL"}
          </button>
        )}
        <div className="flex items-center gap-4 font-mono text-[11.5px] text-ink-faint">
          {aggregate.drafts > 0 && (
            <>
              <span>
                <span className="text-ink-cream-2">{aggregate.drafts}</span> drafted
              </span>
              {aggregate.flagged > 0 && (
                <span className="text-[color:var(--ink-blocked-2)]">
                  · {aggregate.flagged} lint
                </span>
              )}
              <span>
                ·{" "}
                <span
                  className={
                    aggregate.sent > 0 ? "text-[color:var(--ink-receipt-2)]" : "text-ink-muted"
                  }
                >
                  {aggregate.sent}
                </span>{" "}
                sent
              </span>
              {doneEvent?.kind === "done" && <span className="text-ink-muted">· done</span>}
            </>
          )}
          {running && aggregate.drafts === 0 && (
            <span>{latestStage?.kind === "stage" ? `${latestStage.stage}…` : "preparing…"}</span>
          )}
        </div>
        {mode === "edit" && (
          <Button onClick={submit} disabled={running}>
            <Play size={14} />
            {running
              ? "Running…"
              : dryRun
                ? `Generate ${rows.length} draft${rows.length === 1 ? "" : "s"}`
                : `Send ${rows.length} draft${rows.length === 1 ? "" : "s"} for real`}
          </Button>
        )}
        {mode === "progress" && (
          <div className="flex items-center gap-2 text-[12px] text-ink-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>
              Run #{search.runId} in progress · your progress is saved · feel free to navigate away.
            </span>
          </div>
        )}
        {(mode === "done" || mode === "interrupted") && (
          <div className="flex items-center gap-2">
            {search.runId != null && (runRecord?.sentCount ?? 0) > 0 && (
              <Button
                variant="secondary"
                onClick={() => {
                  if (search.runId == null) return;
                  // TanStack navigate keeps the SPA mounted — no full reload,
                  // dev state intact, instant route swap.
                  void globalNavigate({
                    to: "/cadences",
                    search: { sinceRun: search.runId },
                  });
                }}
              >
                <CheckCircle2 size={14} />
                View {runRecord?.sentCount} just-sent in cadences
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setEvents([]);
                setError(null);
                void navigate({ search: (prev) => ({ ...prev, runId: undefined }) });
              }}
            >
              <RefreshCw size={14} />
              Run again
            </Button>
          </div>
        )}
      </section>

      {error && (
        <section className="border-b border-ink-rule border-l-2 border-l-[color:var(--ink-blocked)] bg-[color:var(--ink-blocked)]/8 px-6 py-3">
          <div className="flex items-start gap-2">
            <Badge tone="blocked">error</Badge>
            <span className="font-mono text-[12px] text-[color:var(--ink-blocked-2)]">{error}</span>
          </div>
        </section>
      )}

      {verifyEvent && verifyEvent.kind === "verify" && verifyEvent.dropped.length > 0 && (
        <section className="border-b border-ink-rule border-l-2 border-l-ink-rule bg-ink-surface/40 px-6 py-3">
          <div className="font-mono text-[11.5px] text-ink-faint">
            verify · {verifyEvent.verified} of {verifyEvent.total} deliverable
            {" · "}
            {verifyEvent.dropped.length} dropped
          </div>
          <div className="mt-1 font-mono text-[11px] text-ink-muted">
            {verifyEvent.dropped.map((d) => (
              <div key={`${d.email}::${d.reason}`}>
                {d.email ? mask("email", d.email) : "(missing)"} — {d.reason}
              </div>
            ))}
          </div>
        </section>
      )}

      {(events.length > 0 || running) && (
        <RunLedgerSection eyebrow="Output">
          <div className="flex flex-col gap-4">
            {Array.from(draftedByIndex.entries())
              .toSorted((a, b) => a[0] - b[0])
              .map(([idx, d]) => (
                <div
                  key={idx}
                  className={cn(
                    "relative border-l-2 pl-4",
                    d.flags.length > 0
                      ? "border-[color:var(--ink-blocked)]"
                      : d.receiptIds
                        ? "border-[color:var(--ink-receipt)]"
                        : "border-ink-rule",
                  )}
                >
                  {/* Receipt seal — appears only on successfully sent drafts. */}
                  {d.receiptIds && d.receiptIds.length > 0 && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute right-0 top-1 -rotate-[8deg] select-none font-mono text-[9.5px] uppercase tracking-[0.2em] text-[color:var(--ink-receipt-2)]"
                    >
                      <span className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] border border-[color:var(--ink-receipt)]/50 px-1.5 py-0.5">
                        ✓ signed
                      </span>
                    </span>
                  )}
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-mono text-[11px] text-ink-faint">#{idx + 1}</span>
                    {d.flags.length === 0 && d.receiptIds && <Badge tone="receipt">sent</Badge>}
                    {d.flags.length === 0 && !d.receiptIds && dryRun && <Badge>dry-run</Badge>}
                    {d.flags.length > 0 && <Badge tone="blocked">lint</Badge>}
                  </div>
                  <div className="ln-eyebrow mt-1" style={{ fontSize: 10 }}>
                    subject
                  </div>
                  <div
                    className="mt-0.5 text-ink-cream"
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: 18,
                      fontWeight: 400,
                      letterSpacing: "-0.005em",
                    }}
                  >
                    {d.subject}
                  </div>
                  <div className="ln-eyebrow mt-3" style={{ fontSize: 10 }}>
                    body
                  </div>
                  <pre className="mt-0.5 ln-prose whitespace-pre-wrap text-[13.5px] text-ink-cream-2">
                    {d.body}
                  </pre>
                  {d.flags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {d.flags.map((f) => (
                        <span
                          key={f}
                          className="rounded-[var(--radius-xs)] border border-[color:var(--ink-blocked)]/40 bg-[color:var(--ink-blocked)]/10 px-1.5 py-0.5 font-mono text-[10.5px] text-[color:var(--ink-blocked-2)]"
                        >
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                  {d.receiptIds && d.receiptIds.length > 0 && (
                    <div className="mt-2 flex items-center gap-2 font-mono text-[11px]">
                      <span className="text-ink-faint">receipts</span>
                      {d.receiptIds.map((rid) => (
                        <Link
                          key={rid}
                          to="/receipts"
                          className="text-[color:var(--ink-receipt-2)] hover:underline"
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
                <div
                  key={`${e.index}-${e.message}`}
                  className="font-mono text-[11.5px] text-[color:var(--ink-blocked-2)]"
                >
                  error · {e.message}
                </div>
              ) : null,
            )}
            {doneEvent && doneEvent.kind === "done" && (
              <div className="font-mono text-[11.5px] text-ink-muted">
                done · {doneEvent.sent} of {doneEvent.total} sent
              </div>
            )}
          </div>
        </RunLedgerSection>
      )}
    </div>
  );
}

function RunLedgerSection({
  eyebrow,
  action,
  children,
}: {
  eyebrow: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-ink-rule px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="ln-eyebrow">{eyebrow}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

function stripEmpty(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v.trim().length > 0) out[k] = v.trim();
  }
  return out;
}
