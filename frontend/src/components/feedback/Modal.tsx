"use client";
import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

/** Minimal dialog: dimmed backdrop, Esc / backdrop click closes. Used by the feedback and inventory pages. */
export function Modal({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <button type="button" aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-3 p-5 text-sm">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Text box with eBay's 80-character limit and a live counter. */
export function LimitedText({ value, onChange, max, placeholder }: { value: string; onChange: (v: string) => void; max: number; placeholder?: string }) {
  return (
    <div>
      <textarea className="input h-20" maxLength={max} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      <div className={`mt-1 text-right text-xs ${value.length >= max ? "text-rose-600" : "text-slate-400"}`}>
        {value.length}/{max}
      </div>
    </div>
  );
}
