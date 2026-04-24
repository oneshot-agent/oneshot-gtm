import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";
import { Toggle } from "./Toggle.tsx";

/**
 * Ledger form field — small eyebrow label, walnut-ruled input, a muted
 * caption for hints. Invalid state uses an oxblood rule instead of a
 * red background.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="ln-eyebrow">{label}</span>
      {children}
      {error ? (
        <span className="font-mono text-[11.5px] text-[color:var(--ink-blocked-2)]">{error}</span>
      ) : hint ? (
        <span className="text-[12px] text-ink-faint">{hint}</span>
      ) : null}
    </label>
  );
}

const baseInput = [
  "h-9 w-full",
  "rounded-[var(--radius-sm)]",
  "bg-ink-bg-deep text-ink-cream",
  "border border-ink-rule",
  "px-3 font-sans text-[13.5px] leading-none",
  "placeholder:text-ink-faint",
  "transition-[border-color,background] duration-[var(--dur-stamp)]",
  "hover:border-ink-rule-2",
  "focus:outline-none focus:border-[color:var(--ink-signal)]",
  "focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ink-signal)_20%,transparent)]",
].join(" ");

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(baseInput, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        baseInput,
        "h-auto min-h-[84px] resize-y py-2 font-prose leading-[1.5]",
        className,
      )}
      {...rest}
    />
  );
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(baseInput, "appearance-none pr-8", className)} {...rest} />;
}

/**
 * Boolean field — pill toggle + label. Kept the `Checkbox` export name
 * for backwards compatibility (prop shape still accepts a standard
 * ChangeEvent), but the UI is now a ledger toggle, not a traditional
 * checkbox. All callsites in this app are boolean-state settings
 * (telemetry on/off, dry-run on/off) — semantically a switch, not a
 * multi-select form control.
 */
export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  className,
  id,
}: Pick<InputHTMLAttributes<HTMLInputElement>, "checked" | "onChange" | "disabled" | "id"> & {
  label: string;
  className?: string;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "inline-flex cursor-pointer items-center gap-2.5",
        "font-sans text-[13px] text-ink-cream-2",
        "hover:text-ink-cream",
        disabled && "cursor-not-allowed opacity-60 hover:text-ink-cream-2",
        className,
      )}
    >
      <Toggle
        checked={Boolean(checked)}
        disabled={disabled}
        label={label}
        onChange={(next) => {
          if (onChange) {
            // Preserve the standard form-event shape callers expect.
            onChange({
              target: { checked: next },
              currentTarget: { checked: next },
            } as unknown as React.ChangeEvent<HTMLInputElement>);
          }
        }}
      />
      <span>{label}</span>
    </label>
  );
}
