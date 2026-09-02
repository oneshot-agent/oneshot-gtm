import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { cn } from "../../lib/cn.ts";
import { summarizeDoctor, type DoctorTone } from "../../lib/doctorSummary.ts";
import { DoctorPanel } from "./DoctorPanel.tsx";

const TONE_CLASS: Record<DoctorTone, string> = {
  receipt: "text-[color:var(--ink-receipt-2)]",
  spend: "text-[color:var(--ink-spend-2)]",
  blocked: "text-[color:var(--ink-blocked-2)]",
};

/**
 * One-line install health on Today, expanding to the full grouped DoctorPanel.
 * Reads the SAME ["doctor"] query the nav dot and StatusBar already poll at
 * 60s, so this card costs zero extra requests.
 *
 * It does not open itself. Auto-expanding put a wall of install checks at the
 * top of Today whenever anything was warning, which on a working install is
 * most days, and it buried the signal feed that is the page's subject. The
 * summary line already carries the finding in the tone colour — "2 warnings"
 * in amber is the signal, and opening it is the reader's call.
 */
export function HealthCard() {
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: api.doctor, staleTime: 30_000 });
  const [open, setOpen] = useState(false);
  const summary = summarizeDoctor(doctor.data?.checks);

  return (
    <section className="border-b border-ink-rule">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 px-6 py-2.5 text-left",
          "transition-colors duration-[var(--dur-stamp)] hover:bg-ink-surface/60",
        )}
      >
        <span className="text-ink-faint">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="ln-eyebrow">Health</span>
        <span className={cn("font-mono text-[11px]", TONE_CLASS[summary.tone])}>
          {doctor.isLoading && !doctor.data
            ? "checking…"
            : doctor.isError
              ? "unreachable"
              : summary.text}
        </span>
        {!open && <span className="ml-auto font-mono text-[10px] text-ink-faint">see more</span>}
      </button>
      {open && (
        <div className="px-6 pb-4">
          <DoctorPanel
            checks={doctor.data?.checks}
            isLoading={doctor.isLoading}
            error={doctor.isError ? "unreachable" : null}
          />
        </div>
      )}
    </section>
  );
}
