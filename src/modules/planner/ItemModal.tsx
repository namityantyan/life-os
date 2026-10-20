import { useEffect, useState } from "react";
import { Badge, Button, Field, Input, Modal, Textarea } from "@/components/ui";
import { TYPE_LABEL, type PlannerItem, type PlannerPatch } from "./types";
import { fmtDateTime } from "@/lib/api";
import { fromLocalInput, toLocalInput } from "./time";

export function ItemModal({ item, onClose, onPatch, onDelete }: { item: PlannerItem | null; onClose: () => void; onPatch: (id: string, patch: PlannerPatch) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!item) return;
    setTitle(item.title); setNotes(item.notes ?? ""); setDate(item.date ?? "");
    setStartAt(toLocalInput(item.start_at)); setEndAt(toLocalInput(item.end_at)); setRemindAt(toLocalInput(item.remind_at));
    setBusy(null); setConfirmDelete(false);
  }, [item]);

  if (!item) return <Modal open={false} onClose={onClose}>{null}</Modal>;
  const scheduled = Boolean(item.date || item.start_at || item.remind_at);

  const act = async (key: string, fn: () => Promise<void>, close = true) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); if (close) onClose(); } finally { setBusy(null); }
  };
  const save = () => act("save", async () => {
    const patch: PlannerPatch = { title: title.trim() || item.title, notes: notes.trim() || null };
    if (item.type === "task") patch.date = date || null;
    if (item.type === "event") { patch.start_at = fromLocalInput(startAt); patch.end_at = fromLocalInput(endAt); }
    if (item.type === "reminder") patch.remind_at = fromLocalInput(remindAt);
    await onPatch(item.id, patch);
  });

  return (
    <Modal open={Boolean(item)} onClose={onClose} title={TYPE_LABEL[item.type]}
      footer={<>
        {confirmDelete
          ? <><Button variant="ghost" onClick={() => setConfirmDelete(false)}>戻す</Button><Button variant="danger" loading={busy === "delete"} onClick={() => act("delete", () => onDelete(item.id))} data-testid="item-delete-confirm">削除する</Button></>
          : <><Button variant="danger" onClick={() => setConfirmDelete(true)} data-testid="item-delete">削除</Button><div className="flex-1" /><Button variant="primary" loading={busy === "save"} onClick={save} data-testid="item-save">保存</Button></>}
      </>}>
      <div className="space-y-4" data-testid="item-modal">
        <div className="flex flex-wrap items-center gap-2 text-xs text-label-2">
          {item.done_at && <Badge tone="green">完了 {fmtDateTime(item.done_at)}</Badge>}
          {item.type === "reminder" && item.reminded_at && <Badge tone="orange">通知済み {fmtDateTime(item.reminded_at)}</Badge>}
          {!scheduled && <Badge>日付指定なし</Badge>}
        </div>
        <Field label="タイトル"><Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="item-title" /></Field>
        {item.type === "task" && <Field label="日付"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="item-date" /></Field>}
        {item.type === "event" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="開始"><Input type="datetime-local" step={900} value={startAt} onChange={(e) => setStartAt(e.target.value)} data-testid="item-start" /></Field>
            <Field label="終了"><Input type="datetime-local" step={900} value={endAt} onChange={(e) => setEndAt(e.target.value)} data-testid="item-end" /></Field>
          </div>
        )}
        {item.type === "reminder" && <Field label="通知時刻"><Input type="datetime-local" step={900} value={remindAt} onChange={(e) => setRemindAt(e.target.value)} data-testid="item-remind" /></Field>}
        <Field label="メモ"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-16" data-testid="item-notes" /></Field>
        <div className="flex flex-wrap gap-2">
          {item.type === "task" && (
            <Button variant="tinted" loading={busy === "done"} onClick={() => act("done", () => onPatch(item.id, { done: !item.done_at }))} data-testid="item-done">
              {item.done_at ? "未完了に戻す" : "完了にする"}
            </Button>
          )}
          {scheduled && <Button loading={busy === "unschedule"} onClick={() => act("unschedule", () => onPatch(item.id, { unschedule: true }))} data-testid="item-unschedule">日付指定なしにする</Button>}
        </div>
      </div>
    </Modal>
  );
}
