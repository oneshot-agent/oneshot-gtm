import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { applyMask, type PiiKind } from "./mask.ts";
import { useLocalStorage } from "./useLocalStorage.ts";

/**
 * "Privacy mode" — a global toggle the founder flips before screenshots so
 * structured PII (names, emails, companies, phones) renders partially masked.
 * State persists to localStorage so it survives a refresh. Default off. The
 * masking itself lives in `lib/mask.ts`; the `<Pii>` component reads this.
 */
interface PrivacyContextValue {
  masked: boolean;
  setMasked: (v: boolean) => void;
}

const PrivacyContext = createContext<PrivacyContextValue | null>(null);

const STORAGE_KEY = "privacy-mode";

export function PrivacyProvider({ children }: { children: ReactNode }): ReactNode {
  const [masked, setMasked] = useLocalStorage(STORAGE_KEY);
  const value = useMemo(() => ({ masked, setMasked }), [masked, setMasked]);
  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

/** Read/toggle privacy mode. Returns `masked:false` if used outside a provider. */
export function usePrivacy(): PrivacyContextValue {
  return useContext(PrivacyContext) ?? { masked: false, setMasked: () => {} };
}

/**
 * Mask helper bound to the live privacy state, for string-interpolation sites
 * that can't take a `<Pii>` element — modal titles, `title=` props, template
 * literals. Returns the raw value when privacy is off or the value is empty.
 */
export function useMask(): (kind: PiiKind, value: string | null | undefined) => string {
  const { masked } = usePrivacy();
  return useCallback((kind, value) => applyMask(masked, kind, value), [masked]);
}
