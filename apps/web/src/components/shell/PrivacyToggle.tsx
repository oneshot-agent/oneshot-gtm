import { Eye, EyeOff } from "lucide-react";
import { usePrivacy } from "../../lib/privacy.tsx";
import { cn } from "../../lib/cn.ts";

/**
 * Header toggle for privacy mode — masks structured PII (names, emails,
 * companies, phones) across the dashboard so the founder can screenshot
 * without leaking real contacts. Persists via `usePrivacy` (localStorage).
 */
export function PrivacyToggle() {
  const { masked, setMasked } = usePrivacy();
  return (
    <button
      type="button"
      onClick={() => setMasked(!masked)}
      aria-pressed={masked}
      aria-label={
        masked
          ? "privacy mode on — show real contact data"
          : "privacy mode off — mask contact data for screenshots"
      }
      title={masked ? "Privacy on — PII masked for screenshots" : "Privacy off — click to mask PII"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2 py-1",
        "font-mono text-[11px] transition-colors duration-[var(--dur-stamp)]",
        masked
          ? "border-[color:var(--ink-signal)] bg-ink-surface text-[color:var(--ink-signal-2)]"
          : "border-ink-rule text-ink-faint hover:bg-ink-surface hover:text-ink-cream-2",
      )}
    >
      {masked ? <EyeOff size={12} /> : <Eye size={12} />}
      <span>privacy</span>
    </button>
  );
}
