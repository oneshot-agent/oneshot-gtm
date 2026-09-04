import { useMemo } from "react";
import type { WalletMode } from "@oneshot-gtm/shared-types";
import { Field, Input, Select } from "../primitives/Field.tsx";
import { parseSpendCeiling } from "../../lib/setupValidation.ts";
import { KeyStatusLine } from "./KeyStatusLine.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

const CDP_KEYS = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"] as const;

export function WalletSection({
  cfg,
  sources,
  homeDir,
  onDirtyChange,
}: SectionProps & { homeDir: string }) {
  const server = useMemo(
    () => ({
      walletMode: cfg.walletMode as WalletMode,
      dailySpendCeiling: cfg.dailySpendCeilingUsd == null ? "" : String(cfg.dailySpendCeilingUsd),
    }),
    [cfg],
  );
  const s = useConfigSection({
    id: "wallet",
    server,
    toRequest: (sent) => ({
      ...(sent.walletMode !== undefined ? { walletMode: sent.walletMode } : {}),
      ...(sent.dailySpendCeiling !== undefined
        ? { dailySpendCeilingUsd: ceilingValue(sent.dailySpendCeiling) }
        : {}),
    }),
    validate: (v) => {
      const parsed = parseSpendCeiling(v.dailySpendCeiling);
      return { dailySpendCeiling: parsed.ok ? null : parsed.error };
    },
    onDirtyChange,
  });

  return (
    <SectionShell
      {...s.shell}
      lede={`Keys live only in ${homeDir}/.env chmod 600. Nothing leaves your machine.`}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Wallet mode" className="md:col-span-2">
          <Select
            value={s.values.walletMode}
            onChange={(e) => s.set("walletMode", e.target.value as WalletMode)}
          >
            <option value="cdp">Coinbase CDP server wallet</option>
            <option value="private-key">Raw private key</option>
          </Select>
        </Field>
        <KeyStatusLine
          className="md:col-span-2"
          keys={server.walletMode === "cdp" ? CDP_KEYS : ["AGENT_PRIVATE_KEY"]}
          sources={sources}
          note={
            s.values.walletMode !== server.walletMode
              ? "after saving, add the keys for this mode in Credentials"
              : undefined
          }
        />
        <Field
          label="Daily spend ceiling (USD)"
          className="md:col-span-2"
          error={s.errors.dailySpendCeiling}
          hint="Install-wide cap across every automated finder run and drain — blank = unlimited. Once reached, scheduled/run-now finders and drains halt with a named reason (visible here and in doctor) until local midnight; manual /queue sends are never blocked."
        >
          {/* A text input on purpose: type="number" lets Firefox/Safari accept
              junk and report value="" — exactly the silent path a cap must not
              have. parseSpendCeiling is the validator. */}
          <Input
            inputMode="decimal"
            placeholder="unlimited"
            value={s.values.dailySpendCeiling}
            onChange={(e) => s.set("dailySpendCeiling", e.target.value)}
          />
        </Field>
      </div>
    </SectionShell>
  );
}

/** Only called after validate passed, so the throw is a programming error. */
function ceilingValue(raw: string): number | null {
  const parsed = parseSpendCeiling(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
