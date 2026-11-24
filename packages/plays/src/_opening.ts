import { figuresIn, messageOpeningOf, type OpeningShape } from "@oneshot-gtm/core";
import { hash32, mix32 } from "./_angles.ts";

/** Salt so the opening arm is independent of every other per-prospect hash (angle, format). */
const OPENING_SALT = "opening-shape:";

/**
 * The fixed order a `mixed` prospect moves through, one shape per email. Its
 * length never changes, so a brief edit between two emails cannot land them
 * on the same shape. `figure` sits between `bet` and `question`, so standing
 * in `offer` for it when there is no number never repeats a neighbour.
 */
export const OPENING_ROTATION: readonly OpeningShape[] = ["offer", "bet", "figure", "question"];

/** True when `briefText` gives a number to open on. */
export function briefHasFigure(briefText: string): boolean {
  return figuresIn(briefText).length > 0;
}

/**
 * The opening asked for on the `emailIndex`th email to `email` (0 = first).
 * `offer` (unset) opens on the offer, `problem` on a bet. `mixed` gives each
 * prospect a stable arm and moves one shape per email, never per cadence
 * step. `briefText` is the brief the writer sees: with no number in it, the
 * figure email opens on the offer instead.
 */
export function openingShapeFor(
  cfg: { messageOpening?: unknown; productBrief?: unknown },
  email: string,
  emailIndex: number,
  briefText: string = typeof cfg.productBrief === "string" ? cfg.productBrief : "",
): OpeningShape {
  const mode = messageOpeningOf(cfg);
  if (mode === "offer") return "offer";
  if (mode === "problem") return "bet";
  const n = OPENING_ROTATION.length;
  const arm = Math.min(
    n - 1,
    Math.floor((mix32(hash32(OPENING_SALT + email.trim().toLowerCase())) / 2 ** 32) * n),
  );
  const shape = OPENING_ROTATION[(arm + Math.max(0, emailIndex)) % n]!;
  return shape === "figure" && !briefHasFigure(briefText) ? "offer" : shape;
}

/** The input line that asks for `shape`; null for an offer-first email. */
export function openingLine(shape: OpeningShape): string | null {
  switch (shape) {
    case "offer":
      return null;
    case "bet":
      return "OPENING: problem";
    case "figure":
      return "OPENING: figure";
    case "question":
      return "OPENING: question";
  }
}
