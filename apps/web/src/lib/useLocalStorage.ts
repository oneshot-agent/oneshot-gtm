import { useEffect, useState } from "react";

/**
 * Boolean-flag persistence to localStorage. SSR-safe (initial render uses
 * `initial`; the actual stored value is hydrated in an effect). Swallows
 * errors from private mode / disabled storage so the UI never crashes.
 *
 * First localStorage usage in the web app — kept intentionally minimal.
 * Generalize only when a second consumer appears.
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
  const set = (v: boolean): void => {
    setValue(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      // ignore
    }
  };
  return [value, set];
}
