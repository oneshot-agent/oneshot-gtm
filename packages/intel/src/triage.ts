import { listInbox, type InboxEmail } from "@oneshot-gtm/core";
import { complete } from "./client.ts";
import { loadPrompt } from "./prompts.ts";

type TriageCategory =
  | "interested"
  | "not_now"
  | "wrong_person"
  | "objection"
  | "question"
  | "unsubscribe"
  | "auto_reply"
  | "other";

interface TriagedReply {
  id: string;
  from: string;
  subject: string;
  category: TriageCategory;
  nextStep: string;
  draftedReply: string;
  reasoning: string;
}

export async function triageInbox(
  opts: {
    sinceIso?: string;
    limit?: number;
  } = {},
): Promise<TriagedReply[]> {
  const inboxOpts: { since?: string; limit?: number } = {};
  if (opts.sinceIso) inboxOpts.since = opts.sinceIso;
  inboxOpts.limit = opts.limit ?? 25;
  const inbox = await listInbox(inboxOpts);
  if (inbox.emails.length === 0) return [];
  return triageEmails(inbox.emails);
}

export async function triageEmails(emails: InboxEmail[]): Promise<TriagedReply[]> {
  if (emails.length === 0) return [];
  const system = loadPrompt("triage");
  const user = JSON.stringify(
    emails.map((e) => ({
      id: e.id,
      from: e.from,
      subject: e.subject,
      received_at: e.received_at,
      body: (e.body ?? "").slice(0, 2000),
    })),
    null,
    2,
  );

  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.3,
    maxTokens: 2500,
  });

  const fenced = res.content.match(/```(?:json)?\s*([\s\S]*?)```/);
  let parsed: unknown;
  try {
    parsed = JSON.parse((fenced ? fenced[1] : res.content) ?? "[]");
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];

  const byId = new Map(emails.map((e) => [e.id, e]));
  return parsed.flatMap((item): TriagedReply[] => {
    if (!item || typeof item !== "object") return [];
    const r = item as Record<string, unknown>;
    const id = String(r["id"] ?? "");
    const src = byId.get(id);
    if (!src) return [];
    const category = String(r["category"] ?? "other") as TriageCategory;
    return [
      {
        id,
        from: src.from,
        subject: src.subject,
        category,
        nextStep: String(r["next_step"] ?? "manual_review"),
        draftedReply: String(r["drafted_reply"] ?? "").trim(),
        reasoning: String(r["reasoning"] ?? "").trim(),
      },
    ];
  });
}
