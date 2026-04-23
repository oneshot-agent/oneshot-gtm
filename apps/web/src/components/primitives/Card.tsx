import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-zinc-800 bg-zinc-900/40 backdrop-blur-sm",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-300",
        className,
      )}
      {...rest}
    />
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...rest} />;
}
