/**
 * The display name of every accelerator the finder knows, by registry id.
 * Lives in core so the finder's registry (which names cohorts) and the plays
 * (which write a cohort into copy weeks later) read the same names, and a
 * cohort id never reaches a sentence as a raw slug.
 */
export const ACCELERATOR_NAMES = {
  yc: "Y Combinator",
  spc: "South Park Commons",
  neo: "Neo",
  antler: "Antler",
  techstars: "Techstars",
  "500-global": "500 Global",
  "ai-grant": "AI Grant",
  hf0: "HF0",
  "a16z-speedrun": "a16z speedrun",
} as const satisfies Record<string, string>;

export type AcceleratorId = keyof typeof ACCELERATOR_NAMES;

const YC_BATCH_RX = /^yc[-\s]?([wpxsf])(\d{2})$/i;

/** Registry ids, longest first, so `a16z-speedrun-2026` is never read as a shorter id. */
const IDS_LONGEST_FIRST = (Object.keys(ACCELERATOR_NAMES) as AcceleratorId[]).toSorted(
  (a, b) => b.length - a.length,
);

/**
 * A cohort id as a sentence names it: `yc-s26` → "YC S26", `a16z-speedrun-2026`
 * → "a16z speedrun", `spc-2026-1` → "South Park Commons". An id that starts
 * with a registry id reads as that accelerator's name, whatever year or batch
 * suffix follows. Any other id is humanised: hyphens become spaces, lowercase
 * words are capitalised, and bare numbers (a year, a batch number) are dropped,
 * so `foo-labs-2026` reads "Foo Labs".
 */
export function cohortDisplayName(cohort: string): string {
  const id = cohort.trim();
  if (!id) return "";
  const yc = YC_BATCH_RX.exec(id);
  if (yc) return `YC ${yc[1]!.toUpperCase()}${yc[2]}`;
  const key = id.toLowerCase();
  const known = IDS_LONGEST_FIRST.find((a) => key === a || key.startsWith(`${a}-`));
  if (known) return known === "yc" ? "YC" : ACCELERATOR_NAMES[known];
  const words = id
    .split(/[-_\s]+/)
    .filter((w) => w && !/^\d+$/.test(w))
    .map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w));
  return words.length > 0 ? words.join(" ") : id;
}
