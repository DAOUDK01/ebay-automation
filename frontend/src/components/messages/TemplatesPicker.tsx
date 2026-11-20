"use client";
import { FileText, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Modal } from "@/components/returns/Modal";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui";
import { api, fetcher } from "@/lib/api";
import type { ReplyTemplate } from "@/lib/messages";

/** "Templates" button: pick a saved reply (fills the reply box) or manage the list. */
export function TemplatesPicker({ storeId, onPick, currentText }: { storeId: string; onPick: (body: string) => void; currentText: string }) {
  const key = `/stores/${storeId}/messages/templates`;
  const { data, mutate } = useSWR<{ templates: ReplyTemplate[] }>(key, fetcher);
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [open]);

  const templates = data?.templates ?? [];
  return (
    <div className="relative" ref={ref}>
      <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <FileText className="h-3.5 w-3.5" /> Templates
      </Button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          {templates.length ? (
            <ul className="max-h-64 overflow-y-auto py-1">
              {templates.map((t) => (
                <li key={t._id}>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left hover:bg-slate-50"
                    onClick={() => {
                      onPick(t.body);
                      setOpen(false);
                    }}
                  >
                    <div className="text-sm font-medium text-slate-800">{t.name}</div>
                    <div className="truncate text-xs text-slate-500">{t.body}</div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-3 text-sm text-slate-500">No saved replies yet.</p>
          )}
          <button
            type="button"
            className="block w-full border-t border-slate-100 px-3 py-2 text-left text-sm font-medium text-brand-700 hover:bg-slate-50"
            onClick={() => {
              setManage(true);
              setOpen(false);
            }}
          >
            Manage templates…
          </button>
        </div>
      )}
      <ManageTemplates open={manage} onClose={() => setManage(false)} storeId={storeId} templates={templates} onChanged={() => mutate()} currentText={currentText} />
    </div>
  );
}

function ManageTemplates({
  open,
  onClose,
  storeId,
  templates,
  onChanged,
  currentText,
}: {
  open: boolean;
  onClose: () => void;
  storeId: string;
  templates: ReplyTemplate[];
  onChanged: () => void;
  currentText: string;
}) {
  const [editing, setEditing] = useState<ReplyTemplate | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setEditing(null);
      setName("");
      setBody(currentText);
    }
  }, [open, currentText]);

  async function save() {
    setBusy(true);
    try {
      if (editing) await api(`/stores/${storeId}/messages/templates/${editing._id}`, { method: "PATCH", body: { name, body } });
      else await api(`/stores/${storeId}/messages/templates`, { body: { name, body } });
      toast.success("Template saved");
      setEditing(null);
      setName("");
      setBody("");
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: ReplyTemplate) {
    if (!confirm(`Delete the template "${t.name}"?`)) return;
    try {
      await api(`/stores/${storeId}/messages/templates/${t._id}`, { method: "DELETE" });
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Reply templates" wide busy={busy}>
      <div className="space-y-4">
        {templates.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {templates.map((t) => (
              <li key={t._id} className="flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800">{t.name}</div>
                  <div className="line-clamp-2 text-xs text-slate-500">{t.body}</div>
                </div>
                <button
                  type="button"
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  aria-label={`Edit ${t.name}`}
                  onClick={() => {
                    setEditing(t);
                    setName(t.name);
                    setBody(t.body);
                  }}
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button type="button" className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label={`Delete ${t.name}`} onClick={() => remove(t)}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-3 rounded-lg bg-slate-50 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{editing ? `Edit "${editing.name}"` : "New template"}</div>
          <input className="input" placeholder="Name, e.g. Fitment check" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <textarea className="input min-h-[110px]" placeholder="Hi {buyer}, …" value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">{"{buyer}"} and {"{item}"} are filled in when you use it.</span>
            <div className="flex gap-2">
              {editing && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel edit
                </Button>
              )}
              <Button size="sm" onClick={save} loading={busy} disabled={!name.trim() || !body.trim()}>
                {editing ? "Save changes" : "Add template"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
