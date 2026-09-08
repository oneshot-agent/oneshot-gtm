import { cn } from "../../lib/cn.ts";
import { keyStatus, SECRET_LABELS, type SecretKey } from "./constants.ts";
import { jumpToSection } from "./SectionNav.tsx";
import type { Sources } from "./types.ts";

/**
 * "OPENROUTER_API_KEY · from .env" — the one-line bridge from a preference
 * section to the Credentials section that now owns every secret input.
 */
export function KeyStatusLine({
  keys,
  sources,
  note,
  className,
}: {
  keys: readonly SecretKey[];
  sources: Sources;
  note?: string;
  className?: string;
}) {
  const missing = keys.filter((k) => !sources[k]);
  return (
    <p className={cn("font-mono text-[11px] text-ink-muted", className)}>
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 && " · "}
          <span className={sources[k] ? "text-ink-cream-2" : "text-[color:var(--ink-spend-2)]"}>
            {SECRET_LABELS[k]}
          </span>{" "}
          {keyStatus(sources[k])}
        </span>
      ))}
      {(missing.length > 0 || note) && (
        <>
          {" — "}
          {note ?? "add it in"}
          {!note && (
            <>
              {" "}
              <CredentialsLink />
            </>
          )}
        </>
      )}
    </p>
  );
}

export function CredentialsLink({ children = "Credentials" }: { children?: React.ReactNode }) {
  return (
    <a
      href="#credentials"
      onClick={(e) => {
        e.preventDefault();
        jumpToSection("credentials");
      }}
      className="text-ink-cream-2 underline decoration-ink-faint decoration-1 underline-offset-2 hover:decoration-ink-cream"
    >
      {children}
    </a>
  );
}
