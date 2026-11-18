import { getLedger, saveConfig, type OneShotConfig } from "@oneshot-gtm/core";

/** Roll back the audit entry if the config file cannot be saved. */
export function saveServerConfig(cfg: OneShotConfig, member: string | null, section: string): void {
  const ledger = getLedger();
  ledger.transaction(() => {
    ledger.recordConfigChange({ member, section });
    saveConfig(cfg);
  });
}
