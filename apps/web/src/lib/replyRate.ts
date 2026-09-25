/**
 * Reply-rate display for the draft-outcome panels. A rate on a handful of
 * sends is noise that reads like a result, so below `MIN_SENDS_FOR_RATE` the
 * panel shows the raw count and how far the sample has to go instead.
 */
export const MIN_SENDS_FOR_RATE = 30;

/**
 * "3 replied (4.1%)" once the sample is big enough, else "1 replied · rate
 * after 30 sends (12 so far)". `unit` names what the counts are: draft lines
 * count sends, angle lines count distinct people.
 */
export function replyLabel(replied: number, sends: number, unit = "sends"): string {
  if (sends <= 0) return `${replied} replied`;
  if (sends < MIN_SENDS_FOR_RATE) {
    return `${replied} replied · rate after ${MIN_SENDS_FOR_RATE} ${unit} (${sends} so far)`;
  }
  const pct = (replied / sends) * 100;
  return `${replied} replied (${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%)`;
}
