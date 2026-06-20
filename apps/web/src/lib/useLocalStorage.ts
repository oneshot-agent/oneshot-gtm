import { useCallback, useEffect, useState } from "react";

/**
 * Boolean-flag persistence to localStorage. SSR-safe (initial render uses
 * `initial`; the stored value hydrates in an effect). Swallows private-mode /
 * disabled-storage errors so the UI never crashes.
 */
export function useLocalStorage(key: string, initial = false): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === "1" || raw === "true") setValue(true);
    } catch {
      // private mode / SSR — ignore
    }
  }, [key]);
  // Stable setter so consumers can memoize on it.
  const set = useCallback(
    (v: boolean): void => {
      setValue(v);
      try {
        localStorage.setItem(key, v ? "1" : "0");
      } catch {
        // ignore
      }
    },
    [key],
  );
  return [value, set];
}
