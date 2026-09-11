import { createHash } from "node:crypto";
import { isPersonResearchDossier, loadConfig, personRecordFromResearch } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import {
  describeTargetForAngle,
  edgeFieldOf,
  selectAngle,
  splitEdgeAngles,
  slopFlags,
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
    (a.count !== undefined && (!Number.isInteger(a.count) || a.count < 1))
  )
    return;
  return a;
}

/**
 * How many distinct angles a row's rotation pool holds. The configured
 * `yourEdge` angles seed it; the `angle-alternative` prompt generates the rest
 * on the first rotate, so every click cycles through this many arguments
 * before repeating. Twelve because a three-angle edge plus three generated
 * ones was cycling back to the same argument by the fourth click.
 */
export const ANGLE_POOL_SIZE = 12;

const normalize = (v: string): string =>
  v
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

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
  const fingerprint = createHash("sha256").update(JSON.stringify(positioning)).digest("hex");
  const previous = input.previous;
  const current = previous?.fingerprint === fingerprint ? previous : undefined;
  if (!input.rotate && current) return current;
  const history = current?.history ?? [];
  const research = [
    input.research,
    // The researched person first: current role, employer, history.
    isPersonResearchDossier(target.personResearch) && target.personResearch.status !== "unavailable"
      ? JSON.stringify(personRecordFromResearch(target.personResearch))
      : undefined,
    target.dossier,
    target.dossier_json,
    target.productResearch && typeof target.productResearch === "object"
      ? JSON.stringify(target.productResearch)
      : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const description = describeTargetForAngle(target, research);
  if (!input.rotate) {
    if (!angles.length) return;
    const pick = await selectAngle({
      edge,
      prospectKey: String(target.email ?? target.founderEmail ?? ""),
      description,
      playName: input.playName,
    });
    return {
      text: angles[pick.index]!,
      origin: "configured",
      index: pick.index,
      count: angles.length,
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
  const missing = Math.max(0, ANGLE_POOL_SIZE - pool.length);
  if (missing) {
    if (!cfg.productOneLiner?.trim() && !cfg.productBrief?.trim() && !edge.trim()) {
      throw new Error("Add product positioning before generating alternative angles.");
    }
    const response = await complete({
      messages: [
        { role: "system", content: loadPrompt("angle-alternative") },
        {
          role: "user",
          content: JSON.stringify({
            play: input.playName,
            positioning,
            prospect: description,
            count: missing,
            excludedAngles: pool.map((a) => a.text),
            previousDraftToAvoid: input.previousBody ?? "",
          }),
        },
      ],
      temperature: 0.7,
      // Up to eleven ~60-word angles in one reply, on a model whose reasoning
      // shares this budget (see #586) — 2000 truncated at six.
      maxTokens: 4000,
    });
    const parsed = tryParseJsonObject<{ angles?: unknown }>(response.content, {});
    const additions = Array.isArray(parsed.angles) ? parsed.angles : [];
    if (additions.length !== missing)
      throw new Error(
        `Could not create ${ANGLE_POOL_SIZE} distinct angles. Your draft is unchanged; try again.`,
      );
    for (const value of additions) {
      const text = typeof value === "string" ? value.trim() : "";
      if (
        !text ||
        text.length > 2000 ||
        text.includes("//") ||
        pool.some((a) => normalize(a.text) === normalize(text))
      ) {
        throw new Error(
          `Could not create ${ANGLE_POOL_SIZE} distinct angles. Your draft is unchanged; try again.`,
        );
      }
      // A generated angle is copied into the draft almost verbatim, so the
      // humanizer's phrase bans apply to it too. "the hard part isn't the
      // engineering, it's finding the first ten teams" reached a ready draft
      // this way with no flags.
      if (slopFlags(text).includes("negative-parallelism")) {
        throw new Error(
          "A generated angle used a negation contrast (\"isn't X, it's Y\"). Your draft is unchanged; try again.",
        );
      }
      pool.push({ text, origin: "generated" });
    }
  }
  let previousIndex = previous ? pool.findIndex((a) => a.text === previous.text) : -1;
  if (!previous && angles.length) {
    const pick = await selectAngle({
      edge,
      prospectKey: String(target.email ?? target.founderEmail ?? ""),
      description,
      playName: input.playName,
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
