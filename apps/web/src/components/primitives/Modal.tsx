import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./Button.tsx";

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-zinc-950/70 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-[min(560px,92vw)] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="text-sm font-medium text-zinc-100">{title}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="close">
            <X size={14} />
          </Button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
