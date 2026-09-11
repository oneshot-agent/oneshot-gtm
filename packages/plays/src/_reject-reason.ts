/**
 * `rejectReason` — the one sentence the reject box opens with when the row
 * has nothing better to offer.
 *
 * The box prefills from the person gate's verdict reason or the finder's
 * note first (that ladder lives in the web app, it is free). This is the
 * fallback for the rows that reach a human with neither — most approved
 * rows, where the gate said *pass* and nothing on the row says why one
 * would say no. One small isolated call, the mirror image of
 * `generateFitReason`: same evidence block, same shape rules, same cap,
 * same "never throws" contract. The model may answer null when nothing in
 * the block argues against fit, and that null is respected — an invented
 * mismatch in a human's mouth is worse than an empty box.
 */
import { loadConfig, logEvent } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { describeTargetForAngle } from "./_angles.ts";
import { normalizeFitReason } from "./_fit-reason.ts";

/** Same order of magnitude as `FIT_REASON_COST_ESTIMATE_USD`: one small completion. */
export const REJECT_REASON_COST_ESTIMATE_USD = 0.001;

export interface GenerateRejectReasonInput {
  /** The founder's ICP one-liner; null/blank → no call, null result. */
  icp?: string | null;
  playName: string;
  payload: unknown;
  /** The stored dossier (`prospects.dossier_json`, usually a person-research JSON), when there is one. */
  dossier?: string | null;
  /** A company record (SDK `enrichCompany`) the route fetched when the row had no dossier. */
  company?: Record<string, unknown> | null;
}

/** How much of a dossier the model sees. The 600-char `describeTargetForAngle` slice was written for angle selection; a stage judgment needs the experience history. */
const DOSSIER_CHARS = 2500;

function s(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** The company facts a stage judgment turns on, in a fixed order. */
export function describeCompanyForReject(
  company: Record<string, unknown> | null | undefined,
): string {
  if (!company) return "";
  const lines: string[] = [];
  const push = (label: string, v: unknown) => {
    const t = typeof v === "number" ? String(v) : s(v);
    if (t) lines.push(`${label}: ${t.slice(0, 240)}`);
  };
  push("company", company.name);
  push("industry", company.industry);
  push("founded", company.founded_year ?? company.founded ?? company.year_founded);
  push("employees", company.employee_count ?? company.size);
  push("funding stage", company.funding_stage);
  push("total funding", company.total_funding ?? company.funding_total);
  push("location", company.location);
  push("description", company.description);
  return lines.join("\n");
}

/**
 * The dossier as evidence: a person-research JSON becomes its facts (title,
 * company, summary, the experience history with periods — where "founded
 * 2014, still CEO" lives), anything else is a bounded raw slice.
 */
export function describeDossierForReject(dossier: string | null | undefined): string {
  const raw = dossier?.trim();
  if (!raw) return "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.replace(/\s+/g, " ").slice(0, DOSSIER_CHARS);
  }
  if (!parsed || typeof parsed !== "object")
    return raw.replace(/\s+/g, " ").slice(0, DOSSIER_CHARS);
  const root = parsed as Record<string, unknown>;
  const person = (
    root.result && typeof root.result === "object"
      ? root.result
      : root.person && typeof root.person === "object"
        ? root.person
        : root
  ) as Record<string, unknown>;
  const lines: string[] = [];
  const push = (label: string, v: unknown) => {
    const t = s(v);
    if (t) lines.push(`${label}: ${t.slice(0, 400)}`);
  };
  push("title", person.title ?? person.headline);
  push("company", person.company);
  push("location", person.location);
  push("summary", person.summary ?? person.bio);
  if (Array.isArray(person.experience)) {
    const exp = person.experience
      .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
      .slice(0, 8)
      .map((e) =>
        [s(e.title), s(e.company) && `at ${s(e.company)}`, s(e.period) && `(${s(e.period)})`]
          .filter(Boolean)
          .join(" "),
      )
      .filter(Boolean);
    if (exp.length) lines.push(`experience: ${exp.join("; ")}`);
  }
  if (Array.isArray(person.organizations)) {
    const orgs = person.organizations
      .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
      .map((o) => [s(o.name), s(o.title) && `(${s(o.title)})`].filter(Boolean).join(" "))
      .filter(Boolean);
    if (orgs.length) lines.push(`organizations: ${orgs.join("; ")}`);
  }
  if (lines.length === 0) return raw.replace(/\s+/g, " ").slice(0, DOSSIER_CHARS);
  return lines.join("\n").slice(0, DOSSIER_CHARS);
}

/**
 * The ICP, the play, the prospect's own evidence → a sentence, or null when
 * the model finds no mismatch or the call fails. No ICP configured → null
 * without a call: there is nothing to judge against.
 */
export async function generateRejectReason(
  input: GenerateRejectReasonInput,
): Promise<string | null> {
  const icp = input.icp?.trim() ?? loadConfig().icpOneLiner?.trim() ?? "";
  if (!icp) return null;
  // Payload fields via the angle describer (it already knows which keys are
  // evidence); the dossier and company are rendered here, in full enough
  // form that "this business is ten years old" is visible.
  const evidence = describeTargetForAngle(
    (input.payload && typeof input.payload === "object" ? input.payload : {}) as object,
    null,
  );
  const dossier = describeDossierForReject(input.dossier);
  const company = describeCompanyForReject(input.company);
  try {
    const system = loadPrompt("reject-reason");
    const user = [
      `ICP: ${icp}`,
      `PLAY: ${input.playName}`,
      "PROSPECT:",
      evidence.trim() || "(nothing known beyond name and email)",
      ...(company ? ["", "COMPANY:", company] : []),
      ...(dossier ? ["", "DOSSIER:", dossier] : []),
    ].join("\n");
    const res = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      maxTokens: 160,
    });
    const parsed = tryParseJsonObject<{ rejectReason?: unknown }>(res.content, {});
    const reason = normalizeFitReason(parsed.rejectReason);
    // The prefix is the machine-decision marker downstream; a model that
    // ignored the prompt must not be able to mint one through a human.
    if (!reason || /^auto:/i.test(reason)) return null;
    logEvent("reject_reason.generated", { play: input.playName, reason_120: reason.slice(0, 120) });
    return reason;
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "reject-reason",
        play: input.playName,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}
