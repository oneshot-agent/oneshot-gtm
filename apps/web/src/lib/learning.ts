import type { LearningKind, LearningProposalView } from "@oneshot-gtm/shared-types";

/** Pure helpers for the learning review card, kept out of the component so they can be unit-tested. */

export const LEARNING_KINDS: ReadonlyArray<{ kind: LearningKind; label: string }> = [
  { kind: "preference", label: "Writing" },
  { kind: "prospect_angle", label: "Prospect angle" },
  { kind: "campaign_angle", label: "Campaign angles" },
  { kind: "icp", label: "ICP" },
];

export function learningKindLabel(kind: LearningKind): string {
  return LEARNING_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

export function isLearningKind(v: unknown): v is LearningKind {
  return typeof v === "string" && LEARNING_KINDS.some((k) => k.kind === v);
}

/** A proposal's headline, by kind. */
export function proposalTitle(p: LearningProposalView): string {
  switch (p.kind) {
    case "icp":
      return "Proposed ICP rewrite";
    case "preference":
      return `Proposed writing preference${scopeSuffix(p)}`;
    case "prospect_angle":
      return `Proposed angle revision${p.scope.prospectId != null ? ` · prospect #${p.scope.prospectId}` : ""}`;
    case "campaign_angle":
      return `Proposed angle changes${p.scope.playName ? ` · ${p.scope.playName}` : ""}`;
  }
}

function scopeSuffix(p: LearningProposalView): string {
  const parts = [
    p.scope.channel === "email" ? "email" : p.scope.channel === "linkedin" ? "LinkedIn" : null,
    p.scope.stage === "first_touch"
      ? "first touches"
      : p.scope.stage === "follow_up"
        ? "follow-ups"
        : p.scope.stage === "reply"
          ? "replies"
          : null,
  ].filter((x): x is string => !!x);
  return parts.length ? ` · ${parts.join(" ")}` : " · all channels";
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The one text field the founder may edit before approving, and its current content. */
export function editableText(p: LearningProposalView): { label: string; value: string } {
  switch (p.kind) {
    case "icp":
      return { label: "ICP one-liner", value: text(p.proposed) };
    case "preference":
      return { label: "Instruction", value: text(asRecord(p.proposed)?.["instruction"]) };
    case "prospect_angle":
      return { label: "Hook", value: text(asRecord(p.proposed)?.["hook"]) };
    case "campaign_angle":
      return { label: "Angles (`//`-separated)", value: text(asRecord(p.proposed)?.["edge"]) };
  }
}

/** The approve body carrying an edit, shaped per kind. */
export function editedValue(p: LearningProposalView, edited: string): unknown {
  switch (p.kind) {
    case "icp":
      return edited;
    case "preference":
      return { instruction: edited };
    case "prospect_angle":
      return { hook: edited };
    case "campaign_angle":
      return { edge: edited };
  }
}

/** Lines summarising a current or proposed value, by kind. */
export function valueLines(kind: LearningKind, value: unknown): string[] {
  if (value == null) return [];
  const r = asRecord(value);
  switch (kind) {
    case "icp":
      return text(value) ? [text(value)] : [];
    case "preference":
      return text(r?.["instruction"]) ? [text(r?.["instruction"])] : [];
    case "prospect_angle": {
      const json = text(r?.["angleJson"]);
      const angle = json ? asRecord(safeParse(json)) : r;
      const out: string[] = [];
      if (text(angle?.["hook"])) out.push(`Hook: ${text(angle?.["hook"])}`);
      if (text(angle?.["nextStep"])) out.push(`Next step: ${text(angle?.["nextStep"])}`);
      const doNotSay = angle?.["doNotSay"];
      if (Array.isArray(doNotSay) && doNotSay.length)
        out.push(`Do not say: ${doNotSay.filter((x) => typeof x === "string").join("; ")}`);
      return out;
    }
    case "campaign_angle":
      return splitEdge(text(r?.["edge"]));
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function splitEdge(edge: string): string[] {
  return edge
    .split("//")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `counts` as "label n" chips, in insertion order. */
export function countChips(counts: Record<string, number> | undefined): string[] {
  if (!counts) return [];
  return Object.entries(counts).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`);
}
