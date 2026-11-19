"use client";
import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

/** Simple centered dialog (Escape / backdrop closes it unless `busy`). Shared by returns and messages. */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  busy,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open, busy, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 sm:items-center" onMouseDown={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} rounded-xl bg-white shadow-xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} disabled={busy} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 text-sm text-slate-700">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
