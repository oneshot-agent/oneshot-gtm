/**
 * LinkedIn copy from fixed templates: one text per step, with placeholders
 * filled from facts the drafter already holds. Pure and shared, so the
 * drafters and the Setup page render the same text.
 *
 * The shipped defaults hold for any founder and any product: they carry the
 * placeholders and nothing about the sender. A workspace sets its own text
 * per step in `linkedin.templates`.
 */

export type LinkedInTemplateStep =
  | "note"
  | "noteFallback"
  | "firstMessage"
  | "firstMessageConnected"
  | "lastMessage"
  | "lastMessageFallback"
  | "friendNote";

export type LinkedInTemplatePlaceholder = "first_name" | "evidence" | "offer";

/** LinkedIn's limit on a connection-request note. */
export const LINKEDIN_TEMPLATE_NOTE_MAX = 300;
/** The limit a LinkedIn message is held to. */
export const LINKEDIN_TEMPLATE_MESSAGE_MAX = 400;
/** Longest template text a workspace may save. */
export const LINKEDIN_TEMPLATE_MAX_CHARS = 600;

export interface LinkedInTemplateField {
  step: LinkedInTemplateStep;
  label: string;
  hint: string;
  /** Rendered length limit for this step. */
  limit: number;
  /** Placeholders this step may use. */
  placeholders: readonly LinkedInTemplatePlaceholder[];
}

export const LINKEDIN_TEMPLATE_FIELDS: readonly LinkedInTemplateField[] = [
  {
    step: "note",
    label: "Connection request",
    hint: "Sent when we know why they surfaced. Keep it free of any pitch.",
    limit: LINKEDIN_TEMPLATE_NOTE_MAX,
    placeholders: ["first_name", "evidence"],
  },
  {
    step: "noteFallback",
    label: "Connection request, no evidence",
    hint: "Sent when nothing checked says why they surfaced.",
    limit: LINKEDIN_TEMPLATE_NOTE_MAX,
    placeholders: ["first_name"],
  },
  {
    step: "firstMessage",
    label: "First message",
    hint: "Sent after they accept.",
    limit: LINKEDIN_TEMPLATE_MESSAGE_MAX,
    placeholders: ["first_name", "evidence", "offer"],
  },
  {
    step: "firstMessageConnected",
    label: "First message, already connected",
    hint: "Sent when you were connected before the sequence, so no request was accepted.",
    limit: LINKEDIN_TEMPLATE_MESSAGE_MAX,
    placeholders: ["first_name", "evidence", "offer"],
  },
  {
    step: "lastMessage",
    label: "Last message",
    hint: "The close, when the prospect has an offer.",
    limit: LINKEDIN_TEMPLATE_MESSAGE_MAX,
    placeholders: ["first_name", "evidence", "offer"],
  },
  {
    step: "lastMessageFallback",
    label: "Last message, no offer",
    hint: "The close when the prospect has no offer.",
    limit: LINKEDIN_TEMPLATE_MESSAGE_MAX,
    placeholders: ["first_name", "evidence"],
  },
  {
    step: "friendNote",
    label: "Connection request after an email reply",
    hint: "Sent to someone who replied to your email. No pitch and no question.",
    limit: LINKEDIN_TEMPLATE_NOTE_MAX,
    placeholders: ["first_name"],
  },
];

/** What every step says when the workspace sets no text of its own. */
export const DEFAULT_LINKEDIN_TEMPLATES: Readonly<Record<LinkedInTemplateStep, string>> = {
  note: "Hi {first_name}, saw {evidence}. Would be good to connect.",
  noteFallback: "Hi {first_name}, would be good to connect.",
  firstMessage: "Hi {first_name}, thanks for connecting. What are you working on right now?",
  firstMessageConnected: "Hi {first_name}, what are you working on right now?",
  lastMessage:
    "Hi {first_name}, last one from me, no reply needed. One thing I'd like to do for you: {offer}. Want me to run a small version? A no is fine too.",
  lastMessageFallback:
    "Hi {first_name}, last one from me, no reply needed. If it's ever useful to compare notes, I'm around.",
  friendNote: "Hi {first_name}, we traded emails, so connecting here so the next hello isn't cold.",
};

const PLACEHOLDER_RX = /\{([a-z_]+)\}/g;
const KNOWN: ReadonlySet<string> = new Set<LinkedInTemplatePlaceholder>([
  "first_name",
  "evidence",
  "offer",
]);

/** The placeholder names a template uses, in order of first appearance. */
export function templatePlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER_RX)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** Why a workspace's text for a step can't be saved, or nothing. */
export function templateProblems(step: LinkedInTemplateStep, template: string): string[] {
  const field = LINKEDIN_TEMPLATE_FIELDS.find((f) => f.step === step);
  if (!field) return [`unknown step ${step}`];
  const problems: string[] = [];
  if (template.length > LINKEDIN_TEMPLATE_MAX_CHARS)
    problems.push(`longer than ${LINKEDIN_TEMPLATE_MAX_CHARS} characters`);
  for (const name of templatePlaceholders(template)) {
    if (!KNOWN.has(name)) problems.push(`unknown placeholder {${name}}`);
    else if (!field.placeholders.includes(name as LinkedInTemplatePlaceholder))
      problems.push(`{${name}} can't be used in "${field.label}"`);
  }
  return problems;
}

export type LinkedInTemplateValues = Partial<Record<LinkedInTemplatePlaceholder, string | null>>;

export type LinkedInTemplateRender = { text: string } | { missing: string[] };

function clean(name: string, value: string | null | undefined): string | null {
  const v = value?.replace(/\s+/g, " ").trim();
  if (!v) return null;
  // A clause or an offer drops into a sentence that brings its own full stop.
  return name === "first_name" ? v : v.replace(/[\s.!?;:,]+$/, "") || null;
}

// The opening greeting a missing name can be dropped from: a short word or
// none ("Hi ", "hey ", ""), the name, then a comma, dash or colon.
const GREETING_RX = /^\s*(?:[A-Za-z]{1,8}\s+)?\{first_name\}(?:\s*[,:]|\s+[-–—])?\s*/;

/**
 * Fill a template. Without a usable first name the opening greeting is
 * dropped ("hey {first_name} - saw …" reads "Saw …"); any other placeholder
 * without a value, or a name used past the greeting, leaves it unfilled.
 */
export function renderLinkedInTemplate(
  template: string,
  values: LinkedInTemplateValues,
): LinkedInTemplateRender {
  let text = template;
  const name = clean("first_name", values.first_name);
  if (!name && GREETING_RX.test(text)) {
    text = text.replace(GREETING_RX, "");
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  const missing: string[] = [];
  const filled = text.replace(PLACEHOLDER_RX, (whole, key: string) => {
    const value = KNOWN.has(key) ? clean(key, values[key as LinkedInTemplatePlaceholder]) : null;
    if (value === null) {
      if (!missing.includes(key)) missing.push(key);
      return whole;
    }
    return value;
  });
  if (missing.length > 0) return { missing };
  const out = filled.trim();
  return out ? { text: out } : { missing: ["text"] };
}

export type LinkedInTemplateKind = "note" | "first" | "last" | "friend";

export interface LinkedInTemplateFacts extends LinkedInTemplateValues {
  /** Connected before the sequence: no request was sent or accepted. */
  alreadyConnected?: boolean;
}

export interface ChosenLinkedInTemplate {
  text: string;
  step: LinkedInTemplateStep;
  /** `workspace` when the workspace's own text was used, else `default`. */
  source: "workspace" | "default";
}

/** The step a kind of touch uses, given what is known about the person. */
export function linkedInTemplateStep(
  kind: LinkedInTemplateKind,
  facts: LinkedInTemplateFacts,
): LinkedInTemplateStep {
  switch (kind) {
    case "note":
      return clean("evidence", facts.evidence) ? "note" : "noteFallback";
    case "first":
      return facts.alreadyConnected ? "firstMessageConnected" : "firstMessage";
    case "last":
      return clean("offer", facts.offer) ? "lastMessage" : "lastMessageFallback";
    case "friend":
      return "friendNote";
  }
}

/**
 * The text for one touch: the workspace's template for its step when it
 * fills, else the shipped default. The default always fills: its step is
 * chosen by the facts it needs.
 */
export function chooseLinkedInTemplate(
  kind: LinkedInTemplateKind,
  templates: Partial<Record<LinkedInTemplateStep, string>>,
  facts: LinkedInTemplateFacts,
): ChosenLinkedInTemplate {
  const step = linkedInTemplateStep(kind, facts);
  const candidates: Array<{ template: string; source: "workspace" | "default" }> = [];
  const own = templates[step]?.trim();
  if (own) candidates.push({ template: own, source: "workspace" });
  candidates.push({ template: DEFAULT_LINKEDIN_TEMPLATES[step], source: "default" });
  for (const { template, source } of candidates) {
    const rendered = renderLinkedInTemplate(template, facts);
    if ("text" in rendered) return { text: rendered.text, step, source };
  }
  // Unreachable with the shipped defaults; kept so a bad default can't send braces.
  throw new Error(`no LinkedIn template fills for ${step}`);
}
