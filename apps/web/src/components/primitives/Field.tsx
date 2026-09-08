import { ChevronDown } from "lucide-react";
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Children, cloneElement, isValidElement, useId, type ReactNode } from "react";
import type { ConceptId } from "../../lib/concepts.ts";
import { Explain } from "./Explain.tsx";
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
  explain,
}: {
  /** Usually a string; a node lets a caller append a Badge ("in use"). */
  label: React.ReactNode;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
  explain?: ConceptId;
}) {
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  let controlId = fieldId;
  let bound = false;
  // Bind the first actual control, including an Input beside a helper button.
  // Keep interactive help outside the label and retain explicit control ids.
  function bind(nodes: ReactNode): ReactNode {
    return Children.map(nodes, (child) => {
      if (
        !isValidElement<{
          id?: string;
          children?: ReactNode;
          "aria-describedby"?: string;
          "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
        }>(child)
      )
        return child;
      const control =
        child.type === Input ||
        child.type === Select ||
        child.type === Textarea ||
        child.type === "input" ||
        child.type === "select" ||
        child.type === "textarea";
      if (control && !bound) {
        bound = true;
        controlId = child.props.id ?? fieldId;
        return cloneElement(child, {
          id: controlId,
          "aria-describedby":
            [child.props["aria-describedby"], hint && hintId, error && errorId]
              .filter(Boolean)
              .join(" ") || undefined,
          "aria-invalid": error ? true : child.props["aria-invalid"],
        });
      }
      return child.props.children && child.type !== Field
        ? cloneElement(child, { children: bind(child.props.children) })
        : child;
    });
  }
  const controls = bind(children);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1">
        <label htmlFor={controlId} className="ln-eyebrow">
          {label}
        </label>
        {explain && <Explain concept={explain} />}
      </div>
      {controls}
      {error && (
        <span id={errorId} className="font-mono text-[11.5px] text-[color:var(--ink-blocked-2)]">
          {error}
        </span>
      )}
      {hint && (
        <span id={hintId} className="text-[12px] text-ink-faint">
          {hint}
        </span>
      )}
    </div>
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
  // `appearance-none` strips the native arrow, so without a replacement the
  // control reads as a text input — overlay a chevron to restore the
  // "this opens a menu" affordance.
  return (
    <span className={cn("relative block w-full", className)}>
      <select className={cn(baseInput, "cursor-pointer appearance-none pr-8")} {...rest} />
      <ChevronDown
        size={14}
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
      />
    </span>
  );
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
