import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { api, useApi, fmtDateTime } from "@/lib/api";
import { Badge, Button, Card, EmptyState, Input, Item, PageHeader, PageSkeleton, Segmented, Stagger, Textarea, Toggle, useToast, cx } from "@/components/ui";

type Category = "policy" | "decision" | "promise" | "preference" | "other";
type Note = { id: string; category: Category; content: string; archived_at: string | null; created_at: string; updated_at: string };
type Filter = "all" | Category;

const CATEGORIES: Category[] = ["policy", "decision", "promise", "preference", "other"];
const CAT_LABELS: Record<Category, string> = { policy: "方針", decision: "決定", promise: "約束", preference: "好み", other: "その他" };
const CAT_TONE: Record<Category, "accent" | "green" | "orange" | "purple" | "neutral"> = { policy: "accent", decision: "green", promise: "orange", preference: "purple", other: "neutral" };

export default function Page() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [draft, setDraft] = useState("");
  const [cat, setCat] = useState<Category>("policy");
  const [saving, setSaving] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const params = new URLSearchParams();
  if (filter !== "all") params.set("category", filter);
  if (archived) params.set("archived", "1");
  if (debounced) params.set("q", debounced);
  const qs = params.toString();
  const query = `/notes${qs ? `?${qs}` : ""}`;
  const { data, loading, reload } = useApi<{ items: Note[] }>(query);
  useEffect(() => { if (!loading && data) setFirstLoad(false); }, [loading, data]);

  const add = async () => {
    const content = draft.trim(); if (!content) return;
    setSaving(true);
    try { await api.post("/notes", { category: cat, content }); setDraft(""); toast("追加しました", "success"); reload(true); }
    catch { toast("追加できませんでした", "error"); } finally { setSaving(false); }
  };

  const items = data?.items ?? [];
  const groups = CATEGORIES.map((c) => ({ cat: c, items: items.filter((n) => n.category === c) })).filter((g) => g.items.length > 0);
  if (firstLoad && loading) return <PageSkeleton />;
  return (
    <div>
      <PageHeader title="メモ" subtitle="方針・決定・約束・好みを短く残す場所。" />

      <Card className="mb-6">
        <div className="flex flex-wrap gap-1.5 mb-3" role="radiogroup" aria-label="種類">
          {CATEGORIES.map((c) => (
            <button key={c} role="radio" aria-checked={cat === c} onClick={() => setCat(c)} data-testid={`note-cat-${c}`}
              className={cx("focus-ring pressable rounded-full px-3 h-8 text-sm font-medium transition-colors", cat === c ? "bg-accent text-white" : "bg-fill text-label-2 hover:text-label")}>{CAT_LABELS[c]}</button>
          ))}
        </div>
        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="例：平日は22時以降にトレーニングしない" aria-label="メモ" className="min-h-20" data-testid="note-input"
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") add(); }} />
        <div className="flex items-center justify-between mt-3 gap-3">
          <span className="text-xs text-label-3">アーカイブしていないメモは、BOTやAIの助言の前提として参照されます。</span>
          <Button variant="primary" onClick={add} loading={saving} disabled={!draft.trim()} data-testid="note-add">追加</Button>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Segmented value={filter} onChange={setFilter} options={[{ value: "all" as Filter, label: "すべて" }, ...CATEGORIES.map((c) => ({ value: c as Filter, label: CAT_LABELS[c] }))]} />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="検索" aria-label="検索" className="w-48" data-testid="note-search" />
        <label className="flex items-center gap-2 text-sm text-label-2 ml-auto" data-testid="note-archived-toggle">アーカイブ<Toggle checked={archived} onChange={setArchived} label="アーカイブを表示" /></label>
      </div>

      {groups.length === 0 ? (
        <EmptyState title={archived ? "アーカイブはありません" : debounced ? "該当するメモはありません" : "メモはまだありません"} />
      ) : (
        <Stagger className="space-y-6" key={query}>
          {groups.map((g) => (
            <Item key={g.cat}>
              <div className="flex items-center gap-2 px-1 mb-2"><h2 className="text-lg font-semibold tracking-tight">{CAT_LABELS[g.cat]}</h2><span className="text-sm text-label-3 tabular">{g.items.length}</span></div>
              <Card padded={false} className="divide-y divide-separator">
                <AnimatePresence initial={false}>
                  {g.items.map((n) => <NoteRow key={n.id} note={n} onChanged={() => reload(true)} />)}
                </AnimatePresence>
              </Card>
            </Item>
          ))}
        </Stagger>
      )}
    </div>
  );
}

function NoteRow({ note, onChanged }: { note: Note; onChanged: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.content);
  const [cat, setCat] = useState<Category>(note.category);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(note.content); setCat(note.category); }, [note.content, note.category]);

  const save = async () => {
    const content = text.trim(); if (!content) return;
    setBusy(true);
    try { await api.patch(`/notes/${note.id}`, { content, category: cat }); setEditing(false); toast("保存しました", "success"); onChanged(); }
    catch { toast("保存できませんでした", "error"); } finally { setBusy(false); }
  };
  const archive = async (flag: boolean) => {
    setBusy(true);
    try { await api.patch(`/notes/${note.id}`, { archived: flag }); toast(flag ? "アーカイブしました" : "戻しました"); onChanged(); }
    catch { toast("更新できませんでした", "error"); } finally { setBusy(false); }
  };

  return (
    <div className="p-4" data-testid="note-item">
      {editing ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => (
              <button key={c} onClick={() => setCat(c)} className={cx("focus-ring rounded-full px-2.5 h-7 text-xs font-medium", cat === c ? "bg-accent text-white" : "bg-fill text-label-2")}>{CAT_LABELS[c]}</button>
            ))}
          </div>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-20" data-testid="note-edit-input" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save(); }} />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => { setEditing(false); setText(note.content); setCat(note.category); }}>キャンセル</Button>
            <Button size="sm" variant="primary" onClick={save} loading={busy} disabled={!text.trim()} data-testid="note-edit-save">保存</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className={cx("text-base whitespace-pre-wrap leading-relaxed", note.archived_at && "text-label-2")} data-testid="note-content">{note.content}</p>
            <div className="flex items-center gap-2 mt-1.5 text-xs text-label-3"><Badge tone={CAT_TONE[note.category]}>{CAT_LABELS[note.category]}</Badge><span className="tabular">{fmtDateTime(note.updated_at)}</span></div>
          </div>
          <div className="flex gap-1 shrink-0">
            {!note.archived_at && <Button size="sm" variant="ghost" onClick={() => setEditing(true)} data-testid="note-edit">編集</Button>}
            {note.archived_at
              ? <Button size="sm" variant="ghost" onClick={() => archive(false)} loading={busy} data-testid="note-unarchive">戻す</Button>
              : <Button size="sm" variant="ghost" onClick={() => archive(true)} loading={busy} data-testid="note-archive">アーカイブ</Button>}
          </div>
        </div>
      )}
    </div>
  );
}
