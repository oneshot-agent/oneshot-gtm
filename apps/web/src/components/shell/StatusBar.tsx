import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { DoctorCheck } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { cn } from "../../lib/cn.ts";
import { walletPill } from "../../lib/walletPill.ts";
import { StatusPill } from "../primitives/StatusPill.tsx";

type Tone = "receipt" | "spend" | "blocked" | "neutral";

/**
 * A live strip of doctor-health pills — wallet · llm · ledger. Clicking
 * any pill opens /setup. If a check fails, the pill turns oxblood and
 * signals the founder to fix something before the next run.
 *
 * The wallet pill shows the USDC balance itself (lib/walletPill.ts): an
 * empty wallet refuses every paid call while the env check still reads ok,
 * which is exactly the failure a founder cannot see from the queue. The
 * doctor caches the read for a day; the small refresh control re-reads it,
 * for right after a top-up.
 */
export function StatusBar() {
  const doctor = useQuery({
    queryKey: ["doctor"],
    queryFn: api.doctor,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const checks = doctor.data?.checks ?? [];
  const llm = pickCheck(checks, (c) => c.name.startsWith("llm "));
  const ledger = pickCheck(checks, (c) => c.name === "ledger");

  return (
    <div className="flex items-center gap-1.5">
      <WalletPill checks={checks} loading={doctor.isLoading} />
      <HealthPill label="llm" check={llm} loading={doctor.isLoading} />
      <HealthPill label="ledger" check={ledger} loading={doctor.isLoading} />
    </div>
  );
}

function WalletPill({ checks, loading }: { checks: DoctorCheck[]; loading: boolean }) {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const pill = walletPill(checks, loading);
  const refresh = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (refreshing) return;
    setRefreshing(true);
    try {
      const fresh = await api.doctorRefreshBalance();
      qc.setQueryData(["doctor"], fresh);
      const next = walletPill(fresh.checks);
      toast.message(`wallet · ${next.value}`, { description: next.title });
    } catch (err) {
      toast.error(`couldn't read the balance · ${(err as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-0.5">
      <Link to="/setup" aria-label="wallet — open setup" className="inline-flex">
        <StatusPill label="wallet" value={pill.value} tone={pill.tone} title={pill.title} />
      </Link>
      {pill.hasBalance && (
        <button
          type="button"
          aria-label="re-read the wallet balance"
          title="Re-read the balance now (it refreshes daily on its own)"
          disabled={refreshing}
          onClick={(e) => void refresh(e)}
          className={cn(
            "rounded p-0.5 text-ink-faint hover:text-ink-cream-2 disabled:opacity-50",
            refreshing && "animate-spin",
          )}
        >
          <RefreshCw size={10} />
        </button>
      )}
    </span>
  );
}

function HealthPill({
  label,
  check,
  loading,
}: {
  label: string;
  check: DoctorCheck | null;
  loading: boolean;
}) {
  const tone: Tone = !check ? "neutral" : severityTone(check.severity);
  const value = loading ? "…" : !check ? "—" : shortValue(check);
  return (
    <Link to="/setup" aria-label={`${label} — open setup`} className="inline-flex">
      <StatusPill label={label} value={value} tone={tone} title={check?.message ?? "unknown"} />
    </Link>
  );
}

function pickCheck(checks: DoctorCheck[], pred: (c: DoctorCheck) => boolean): DoctorCheck | null {
  return checks.find(pred) ?? null;
}

function severityTone(s: DoctorCheck["severity"]): Tone {
  if (s === "ok") return "receipt";
  if (s === "warn") return "spend";
  return "blocked";
}

/**
 * One-word value per pill: for LLM the provider name, for ledger just
 * "ok"/"warn"/"fail" since the message is verbose.
 */
function shortValue(c: DoctorCheck): string {
  if (c.severity === "fail") return "fail";
  if (c.severity === "warn") return "warn";
  if (c.name.includes("llm")) {
    const match = c.name.match(/\((\w+)\)/);
    return match?.[1] ?? "ok";
  }
  return "ok";
}
