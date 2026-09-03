/**
 * Score-bucket bands shared by the CLI shadow report and the outcome report
 * (moved from apps/cli so packages/find can use them; the CLI re-exports).
 */
export const SCORE_BUCKETS = ["0-19", "20-39", "40-59", "60-79", "80-100"] as const;

export function bucketOf(total: number): (typeof SCORE_BUCKETS)[number] {
  if (total < 20) return "0-19";
  if (total < 40) return "20-39";
  if (total < 60) return "40-59";
  if (total < 80) return "60-79";
  return "80-100";
}
