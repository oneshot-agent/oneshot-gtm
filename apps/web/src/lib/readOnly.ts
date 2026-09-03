import { IS_DEMO } from "../api/demo.ts";

/**
 * Props for a control that writes, so the vendored demo can grey it out.
 *
 * The refusal itself lives in the transport (src/api/demo.ts) and the report
 * lives in main.tsx's mutation cache, which between them already cover all 29
 * mutation sites. This is the courtesy on top: the buttons a visitor reaches
 * first should look unavailable before they are clicked, rather than accepting
 * the click and answering with a toast.
 *
 * Spread it LAST, so it wins over a `disabled` the control was already
 * computing:
 *
 *   <Button disabled={save.isPending} onClick={…} {...readOnly}>
 *
 * Outside a demo build it is an empty object and nothing changes.
 */
export const readOnly: { disabled?: true; title?: string } = IS_DEMO
  ? { disabled: true, title: "Read-only demo. This action runs on your own install." }
  : {};

/**
 * The same fact as a boolean, for controls that derive their own disabled
 * state instead of taking it as a prop — the trigger row's toggle, and its
 * `run now`, which gates clicks through pointer-events rather than `disabled`.
 */
export const READ_ONLY = IS_DEMO;
