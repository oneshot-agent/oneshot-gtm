import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { DoctorCheck } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { StatusPill } from "../primitives/StatusPill.tsx";

type Tone = "receipt" | "spend" | "blocked" | "neutral";

/**
 * A live strip of doctor-health pills — wallet · llm · ledger. Clicking
 * any pill opens /setup. If a check fails, the pill turns oxblood and
 * signals the founder to fix something before the next run.
 */
export function StatusBar() {
  const doctor = useQuery({
    queryKey: ["doctor"],
    queryFn: api.doctor,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const checks = doctor.data?.checks ?? [];
  const wallet = pickCheck(checks, (c) => c.name.includes("wallet"));
  const llm = pickCheck(checks, (c) => c.name.startsWith("llm "));
  const ledger = pickCheck(checks, (c) => c.name === "ledger");

  return (
    <div className="flex items-center gap-1.5">
      <HealthPill label="wallet" check={wallet} loading={doctor.isLoading} />
      <HealthPill label="llm" check={llm} loading={doctor.isLoading} />
      <HealthPill label="ledger" check={ledger} loading={doctor.isLoading} />
    </div>
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
 * One-word value per pill. For wallet we show the env source (env/file),
 * for LLM the provider name, for ledger just "ok"/"warn"/"fail" since
 * the message is verbose.
 */
function shortValue(c: DoctorCheck): string {
  if (c.severity === "fail") return "fail";
  if (c.severity === "warn") return "warn";
  // ok — extract a terse token from the message
  if (c.name.includes("llm")) {
    const match = c.name.match(/\((\w+)\)/);
    return match?.[1] ?? "ok";
  }
  if (c.name.includes("wallet")) {
    return c.message.includes("AGENT_PRIVATE_KEY") ? "pk" : "cdp";
  }
  return "ok";
}
