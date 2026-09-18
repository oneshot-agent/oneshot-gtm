import { parseQueueIds } from "@oneshot-gtm/shared-types";

interface RunSearch {
  fromQueue?: "1";
  limit?: number;
  dryRun?: "0" | "1";
  /**
   * Explicit queue-row ids ("drain selected"). When present, hydration loads
   * exactly these rows instead of the play's newest `limit` approved ones.
   */
  ids?: number[];
  /**
   * In-progress / done / interrupted mode: fetch GET /api/runs/:runId and render
   * server-side per-target state, polling every 2s while running. Survives
   * navigate-away; a cold-boot sweep shows it as 'interrupted'.
   */
  runId?: number;
}

export function validateRunSearch(search: Record<string, unknown>): RunSearch {
  const out: RunSearch = {};
  if (search["fromQueue"] === "1" || search["fromQueue"] === 1) out.fromQueue = "1";
  if (typeof search["limit"] === "number") out.limit = search["limit"];
  else if (typeof search["limit"] === "string" && /^\d+$/.test(search["limit"])) {
    out.limit = Number.parseInt(search["limit"], 10);
  }
  // Keep an explicit-but-empty pick (`?ids=`, `?ids=abc`) as `[]` rather than
  // dropping the field — hydration must load nothing, not silently widen to
  // the play's whole approved batch.
  const ids = parseQueueIds(
    search["ids"] == null
      ? null
      : typeof search["ids"] === "string" || typeof search["ids"] === "number"
        ? String(search["ids"])
        : "",
  );
  if (ids) out.ids = ids;
  if (search["dryRun"] === "0" || search["dryRun"] === 0) out.dryRun = "0";
  if (search["dryRun"] === "1" || search["dryRun"] === 1) out.dryRun = "1";
  if (typeof search["runId"] === "number") out.runId = search["runId"];
  else if (typeof search["runId"] === "string" && /^\d+$/.test(search["runId"])) {
    out.runId = Number.parseInt(search["runId"], 10);
  }
  return out;
}
