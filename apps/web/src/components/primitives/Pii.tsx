import type { ReactNode } from "react";
import { applyMask, type PiiKind } from "../../lib/mask.ts";
import { usePrivacy } from "../../lib/privacy.tsx";

/**
 * Renders a piece of PII, partially masked when privacy mode is on (see
 * `usePrivacy`). Use at every render site that shows a prospect name, email,
 * company, or phone. For string-interpolation sites that can't take an element,
 * call the `mask*` helpers directly with `usePrivacy().masked` instead.
 */
export function Pii({ kind, children }: { kind: PiiKind; children: string }): ReactNode {
  const { masked } = usePrivacy();
  return applyMask(masked, kind, children);
}
