import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

const buttonStyles = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-zinc-100 text-zinc-900 hover:bg-zinc-200",
        secondary: "border border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800",
        ghost: "text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100",
        danger: "bg-red-600 text-zinc-100 hover:bg-red-700",
      },
      size: {
        sm: "h-7 px-2 text-xs",
        md: "h-8 px-3",
        lg: "h-10 px-4 text-base",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {}

export function Button({ className, variant, size, ...rest }: ButtonProps) {
  return <button className={cn(buttonStyles({ variant, size }), className)} {...rest} />;
}
