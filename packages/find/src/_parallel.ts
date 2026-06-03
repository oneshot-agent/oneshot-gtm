// parallelMap now lives in @oneshot-gtm/core so `plays` can share it without a
// cross-package dependency. Re-exported here so the finders' existing imports
// (`./_parallel.ts`) keep working unchanged.
export { parallelMap } from "@oneshot-gtm/core";
