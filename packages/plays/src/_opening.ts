import { figuresIn, messageOpeningOf, type OpeningShape } from "@oneshot-gtm/core";
import { hash32, mix32 } from "./_angles.ts";

/** Salt so the opening arm is independent of every other per-prospect hash (angle, format). */
const OPENING_SALT = "opening-shape:";

/**
 * The shapes a `mixed` workspace splits its emails across. `figure` only
 * when the product brief gives a number to open on.
 */
export function openingPool(cfg: { productBrief?: unknown }): OpeningShape[] {
  const brief = typeof cfg.productBrief === "string" ? cfg.productBrief : "";
  return figuresIn(brief).length > 0
    ? ["offer", "bet", "figure", "question"]
    : ["offer", "bet", "question"];
}

/**
 * The opening an email to `email` is asked for at `stepIndex` (0 = the first
 * email). `offer` (unset) always opens on the offer and `problem` always on a
 * bet. `mixed` gives each prospect a stable arm, and each follow-up moves to
 * the next shape so no reader gets the same opening twice in a row.
 */
export function openingShapeFor(
  cfg: { messageOpening?: unknown; productBrief?: unknown },
  email: string,
  stepIndex: number,
): OpeningShape {
  const mode = messageOpeningOf(cfg);
  if (mode === "offer") return "offer";
  if (mode === "problem") return "bet";
  const pool = openingPool(cfg);
  const arm = Math.floor(
    (mix32(hash32(OPENING_SALT + email.trim().toLowerCase())) / 2 ** 32) * pool.length,
  );
  return pool[(Math.min(arm, pool.length - 1) + Math.max(0, stepIndex)) % pool.length]!;
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
