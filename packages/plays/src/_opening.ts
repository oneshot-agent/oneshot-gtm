import { figuresIn, messageOpeningOf, type OpeningShape } from "@oneshot-gtm/core";
import { hash32, mix32 } from "./_angles.ts";

/** Salt so the opening arm is independent of every other per-prospect hash (angle, format). */
const OPENING_SALT = "opening-shape:";

/**
 * The shapes a `mixed` workspace splits its emails across. `figure` only
 * when the product brief gives a number to open on.
 */
export function openingPool(
  cfg: { productBrief?: unknown },
  briefText: string = typeof cfg.productBrief === "string" ? cfg.productBrief : "",
): OpeningShape[] {
  return figuresIn(briefText).length > 0
    ? ["offer", "bet", "figure", "question"]
    : ["offer", "bet", "question"];
}

/**
 * The opening asked for on the `emailIndex`th email to `email` (0 = first).
 * `offer` (unset) opens on the offer, `problem` on a bet. `mixed` gives each
 * prospect a stable arm and moves one shape per email, never per cadence
 * step, so no reader gets one opening twice in a row. `briefText` is the
 * brief the writer sees: a figure is only asked for when it holds one.
 */
export function openingShapeFor(
  cfg: { messageOpening?: unknown; productBrief?: unknown },
  email: string,
  emailIndex: number,
  briefText?: string,
): OpeningShape {
  const mode = messageOpeningOf(cfg);
  if (mode === "offer") return "offer";
  if (mode === "problem") return "bet";
  const pool = openingPool(cfg, briefText);
  const arm = Math.floor(
    (mix32(hash32(OPENING_SALT + email.trim().toLowerCase())) / 2 ** 32) * pool.length,
  );
  return pool[(Math.min(arm, pool.length - 1) + Math.max(0, emailIndex)) % pool.length]!;
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
