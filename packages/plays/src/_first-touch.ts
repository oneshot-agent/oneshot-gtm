import { loadPrompt } from "@oneshot-gtm/intel";
import { hash32 } from "./_angles.ts";

/**
 * The first-touch format a trigger opts into (issue: measured first-touch
 * formats). `standard` is the play's own prompt, unchanged; `brief` adds a
 * binding FORMAT block (≤3 sentences, no about-you opener, register by
 * seniority); `split` puts each prospect in one arm by a stable hash so the
 * two can be compared on the same finder's traffic. Nothing is decided for
 * the founder: the arms are measured and shown side by side, never switched
 * automatically.
 */
export type FirstTouchFormat = "standard" | "brief";
export type FirstTouchSetting = FirstTouchFormat | "split";

export const BRIEF_MAX_SENTENCES = 3;
export const BRIEF_MAX_WORDS = 70;
const DEFAULT_SPLIT = 0.5;
/** Salt so the arm is independent of every other per-prospect hash (admission slot, angle fallback). */
const ARM_SALT = "first-touch-format:";

export type ReaderSeniority = "exec" | "lead" | "individual" | "unknown";

function settingOf(v: unknown): FirstTouchSetting | null {
  return v === "standard" || v === "brief" || v === "split" ? v : null;
}

/**
 * The arm this prospect's first touch is drafted in, or `null` when the
 * trigger never set `firstTouchFormat` (the draft is then untracked by format
 * and byte-identical to before). Deterministic per email, so a regenerate or
 * a later send lands in the same arm without storing it.
 */
export function firstTouchArm(target: unknown, email: string): FirstTouchFormat | null {
  if (!target || typeof target !== "object") return null;
  const t = target as { firstTouchFormat?: unknown; firstTouchSplit?: unknown };
  const setting = settingOf(t.firstTouchFormat);
  if (setting === null) return null;
  if (setting !== "split") return setting;
  const raw = typeof t.firstTouchSplit === "number" ? t.firstTouchSplit : DEFAULT_SPLIT;
  const share = Math.min(1, Math.max(0, raw));
  const bucket = hash32(ARM_SALT + email.trim().toLowerCase()) / 2 ** 32;
  return bucket < share ? "brief" : "standard";
}

const EXEC =
  /\b(?:chief|c[eotfmrpi]o|founder|co-?founder|owner|president|partner|vp|vice president|svp|evp|head of|managing director|general manager)\b/i;
const LEAD = /\b(?:director|lead|manager|head|staff|principal|architect|supervisor)\b/i;
const INDIVIDUAL =
  /\b(?:engineer|developer|designer|analyst|scientist|researcher|specialist|associate|coordinator|consultant|student|intern|representative|writer|builder)\b/i;

/** Coarse seniority from a title string alone. `unknown` when there is no title or nothing matches. */
export function readerSeniority(title: string | null | undefined): ReaderSeniority {
  const t = (title ?? "").trim();
  if (!t) return "unknown";
  if (EXEC.test(t)) return "exec";
  if (LEAD.test(t)) return "lead";
  if (INDIVIDUAL.test(t)) return "individual";
  return "unknown";
}

/** The FORMAT block the brief arm appends to the play's input. */
export function briefFormatBlock(title: string | null | undefined): string {
  return `${loadPrompt("_format-brief").trim()}\n\nREADER SENIORITY: ${readerSeniority(title)}`;
}
