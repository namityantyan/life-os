import { useEffect, useState } from "react";
import { Button, Field, Input, Modal, Segmented, Textarea } from "@/components/ui";
import { TYPE_LABEL, type PlannerCreate, type PlannerType } from "./types";
import { fmtMD, fromLocalInput, isoAt, toLocalInput, todayStr } from "./time";

export type AddPreset = {
  /** Preselected type. */
  type?: PlannerType;
  /** When set, the modal was opened from a grid cell: only タスク/予定 are offered. */
  date?: string;
  /** Minutes after midnight (grid cell); undefined = all-day row. */
  minutes?: number;
};

const ALL: PlannerType[] = ["task", "reminder", "event"];
const CELL: PlannerType[] = ["task", "event"];

export function AddModal({ open, preset, onClose, onCreate }: { open: boolean; preset: AddPreset | null; onClose: () => void; onCreate: (body: PlannerCreate) => Promise<void> }) {
  const fromCell = Boolean(preset?.date);
  const [type, setType] = useState<PlannerType>("task");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const t = preset?.type ?? (preset?.minutes != null ? "event" : "task");
    setType(t); setTitle(""); setNotes(""); setBusy(false);
    const d = preset?.date ?? todayStr();
    const m = preset?.minutes ?? 9 * 60;
    setDate(preset?.date ?? "");
    setStartAt(toLocalInput(isoAt(d, m)));
    setEndAt(toLocalInput(isoAt(d, m + 60)));
    setRemindAt(toLocalInput(isoAt(d, m)));
  }, [open, preset]);

  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const body: PlannerCreate = { type, title: t, notes: notes.trim() || null };
      if (type === "task") body.date = date || null;
      if (type === "event") { body.start_at = fromLocalInput(startAt); body.end_at = fromLocalInput(endAt); }
      if (type === "reminder") body.remind_at = fromLocalInput(remindAt);
      await onCreate(body);
      onClose();
    } finally { setBusy(false); }
  };

  const heading = fromCell && preset?.date ? `追加 — ${fmtMD(preset.date)}${preset.minutes != null ? ` ${String(Math.floor(preset.minutes / 60)).padStart(2, "0")}:${String(preset.minutes % 60).padStart(2, "0")}` : " 終日"}` : "追加";

  return (
    <Modal open={open} onClose={onClose} title={heading}
      footer={<><Button variant="ghost" onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={submit} loading={busy} disabled={!title.trim()} data-testid="add-submit">追加</Button></>}>
      <div className="space-y-4" data-testid="add-modal">
        <Segmented value={type} onChange={setType} options={(fromCell ? CELL : ALL).map((v) => ({ value: v, label: <span data-testid={`add-type-${v}`}>{TYPE_LABEL[v]}</span> }))} />
        <Field label="タイトル">
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type === "task" ? "やること" : type === "event" ? "予定の名前" : "知らせてほしいこと"} data-testid="add-title"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        </Field>
        {type === "task" && <Field label="日付" hint="空欄のままだと「日付指定なし」に入ります"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="add-date" /></Field>}
        {type === "event" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="開始"><Input type="datetime-local" step={900} value={startAt} onChange={(e) => setStartAt(e.target.value)} data-testid="add-start" /></Field>
            <Field label="終了"><Input type="datetime-local" step={900} value={endAt} onChange={(e) => setEndAt(e.target.value)} data-testid="add-end" /></Field>
          </div>
        )}
        {type === "reminder" && <Field label="通知時刻" hint="空欄だと通知されず「日付指定なし」に入ります"><Input type="datetime-local" step={900} value={remindAt} onChange={(e) => setRemindAt(e.target.value)} data-testid="add-remind" /></Field>}
        <Field label="メモ"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-16" /></Field>
      </div>
    </Modal>
  );
}
