import { isPersonResearchDossier, loadConfig, personRecordFromResearch } from "@oneshot-gtm/core";
import {
  angleAssignmentOf,
  angleTextKey,
  describeTargetForAngle,
  edgeFieldOf,
  generateAlternativeAngles,
  positioningFingerprint,
  selectAngle,
  splitEdgeAngles,
} from "@oneshot-gtm/plays";
import type { DraftAngle } from "@oneshot-gtm/shared-types";

export function parseDraftAngle(value: unknown): DraftAngle | undefined {
  if (!value || typeof value !== "object") return;
  const a = value as DraftAngle;
  if (
    typeof a.text !== "string" ||
    !a.text.trim() ||
    typeof a.fingerprint !== "string" ||
    !["configured", "generated"].includes(a.origin) ||
    !Array.isArray(a.history) ||
    !a.history.every((v) => typeof v === "string") ||
    (a.pool !== undefined &&
      (!Array.isArray(a.pool) ||
        a.pool.some(
          (v) =>
            !v ||
            typeof v.text !== "string" ||
            !v.text.trim() ||
            !["configured", "generated"].includes(v.origin),
        ))) ||
    (a.index !== undefined && (!Number.isInteger(a.index) || a.index < 0)) ||
    (a.count !== undefined && (!Number.isInteger(a.count) || a.count < 1)) ||
    (a.assignment !== undefined && a.assignment !== "arm")
  )
    return;
  return a;
}

// The ledger's angle key (ledger-drafts.ts): one identity for an angle's text everywhere.
const normalize = angleTextKey;

/** Chooses a preview argument; never changes trigger config or sends a message. */
export async function draftAngleFor(input: {
  target: unknown;
  playName: string;
  previous?: DraftAngle;
  previousBody?: string;
  research?: string;
  rotate: boolean;
}): Promise<DraftAngle | undefined> {
  if (!input.target || typeof input.target !== "object" || Array.isArray(input.target)) {
    if (input.rotate) throw new Error("This row has no usable prospect context.");
    return;
  }
  const target = input.target as Record<string, unknown>;
  const cfg = loadConfig();
  const field = edgeFieldOf(target);
  const edge = field ? String(target[field]) : "";
  const angles = splitEdgeAngles(edge);
  const positioning = {
    product: cfg.productOneLiner,
    brief: cfg.productBrief,
    icp: cfg.icpOneLiner,
    edge,
  };
  const fingerprint = positioningFingerprint(edge);
  const previous = input.previous;
  const current = previous?.fingerprint === fingerprint ? previous : undefined;
  if (!input.rotate && current) return current;
  const history = current?.history ?? [];
  const research = [
    // The researched person first: describeTargetForAngle keeps only the
    // first 600 characters of research, and a caller's dossier can be longer.
    isPersonResearchDossier(target.personResearch) && target.personResearch.status !== "unavailable"
      ? JSON.stringify(personRecordFromResearch(target.personResearch))
      : undefined,
    input.research,
    target.dossier,
    target.dossier_json,
    target.productResearch && typeof target.productResearch === "object"
      ? JSON.stringify(target.productResearch)
      : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const description = describeTargetForAngle(target, research);
  const assignment = angleAssignmentOf(target);
  if (!input.rotate) {
    if (!angles.length) return;
    const pick = await selectAngle({
      edge,
      prospectKey: String(target.email ?? target.founderEmail ?? ""),
      description,
      playName: input.playName,
      assignment,
    });
    return {
      text: angles[pick.index]!,
      origin: "configured",
      index: pick.index,
      count: angles.length,
      ...(pick.method === "arm" ? { assignment: "arm" as const } : {}),
      fingerprint,
      history: [],
    };
  }
  const pool: NonNullable<DraftAngle["pool"]> = current?.pool?.length
    ? current.pool.map((a) => ({ ...a }))
    : angles.map((text) => ({ text, origin: "configured" }));
  // Preserve alternatives from older drafts when their positioning still matches.
  for (const text of [...history, ...(current?.origin === "generated" ? [current.text] : [])]) {
    if (!pool.some((a) => normalize(a.text) === normalize(text)))
      pool.push({ text, origin: "generated" });
  }
  // Rotation uses the angles already available, even for older, smaller pools.
  // Only ask for alternatives when there is no different angle to rotate to.
  const distinct = new Set(pool.map((a) => normalize(a.text)));
  const missing = distinct.size < 2 ? 1 : 0;
  if (missing) {
    if (!cfg.productOneLiner?.trim() && !cfg.productBrief?.trim() && !edge.trim()) {
      throw new Error("Add product positioning before generating alternative angles.");
    }
    const additions = await generateAlternativeAngles({
      playName: input.playName,
      positioning,
      prospect: description,
      count: missing,
      excluded: pool.map((a) => a.text),
      ...(input.previousBody ? { previousDraftToAvoid: input.previousBody } : {}),
    });
    for (const text of additions) pool.push({ text, origin: "generated" });
  }
  let previousIndex = previous ? pool.findIndex((a) => a.text === previous.text) : -1;
  if (!previous && angles.length) {
    // Rotating away from where the prospect would have started: under the
    // arm split that is their arm, so the rotation moves off it.
    const pick = await selectAngle({
      edge,
      prospectKey: String(target.email ?? target.founderEmail ?? ""),
      description,
      playName: input.playName,
      assignment,
    });
    previousIndex = pick.index;
  }
  const index = (previousIndex + 1) % pool.length;
  const chosen = pool[index]!;
  return {
    ...chosen,
    index,
    count: pool.length,
    fingerprint,
    pool,
    history: pool.filter((a) => a.origin === "generated").map((a) => a.text),
  };
}
