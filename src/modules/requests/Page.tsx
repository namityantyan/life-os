import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { api, useApi, fmtDateTime } from "@/lib/api";
import { Badge, Button, EmptyState, Field, Input, Item, Modal, PageHeader, PageSkeleton, Segmented, Select, Stagger, Textarea, useToast } from "@/components/ui";

type Status = "open" | "in_progress" | "done";
type Req = { id: string; title: string; detail: string | null; example: string | null; status: Status; created_at: string; updated_at: string };
type Filter = "all" | Status;

const STATUSES: Status[] = ["open", "in_progress", "done"];
const STATUS_LABELS: Record<Status, string> = { open: "未対応", in_progress: "対応中", done: "完了" };
const STATUS_TONE: Record<Status, "neutral" | "accent" | "green"> = { open: "neutral", in_progress: "accent", done: "green" };

export default function Page() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [modal, setModal] = useState<{ mode: "new" } | { mode: "edit"; item: Req } | null>(null);
  const [firstLoad, setFirstLoad] = useState(true);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const params = new URLSearchParams();
  if (filter !== "all") params.set("status", filter);
  if (debounced) params.set("q", debounced);
  const qs = params.toString();
  const query = `/requests${qs ? `?${qs}` : ""}`;
  const { data, loading, error, reload } = useApi<{ items: Req[] }>(query);
  useEffect(() => { if (!loading && data) setFirstLoad(false); }, [loading, data]);

  const setStatus = async (item: Req, status: Status) => {
    try { await api.patch(`/requests/${item.id}`, { status }); reload(true); }
    catch { toast("更新できませんでした", "error"); }
  };

  const items = data?.items ?? [];
  if (firstLoad && loading) return <PageSkeleton />;
  return (
    <div>
      <PageHeader title="リクエスト" subtitle="Life OSへの要望を記録して、対応状況を管理します。登録だけで自動的に反映されることはありません。"
        actions={<Button variant="primary" onClick={() => setModal({ mode: "new" })} data-testid="request-add">追加</Button>} />

      {error && !data && <div role="alert" data-testid="load-error" className="card p-4 mb-4 flex items-center justify-between gap-3 text-sm text-red"><span>読み込めませんでした：{error}</span><Button size="sm" onClick={() => reload()}>再読み込み</Button></div>}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Segmented value={filter} onChange={setFilter} options={[{ value: "all" as Filter, label: "すべて" }, ...STATUSES.map((s) => ({ value: s as Filter, label: STATUS_LABELS[s] }))]} />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="タイトル・詳細を検索" aria-label="検索" className="w-56" data-testid="request-search" />
      </div>

      {error && !data ? null : items.length === 0 ? (
        <EmptyState title={debounced ? "該当するリクエストはありません" : "リクエストはまだありません"} action={!debounced && filter === "all" ? <Button onClick={() => setModal({ mode: "new" })}>最初のリクエストを追加</Button> : undefined} />
      ) : (
        <Stagger className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3" key={query}>
          <AnimatePresence initial={false}>
            {items.map((it) => (
              <Item key={it.id}>
                <div className="card p-5 h-full flex flex-col gap-3" data-testid="request-card">
                  <button className="text-left min-w-0 flex-1 focus-ring rounded-[var(--radius-sm)]" onClick={() => setModal({ mode: "edit", item: it })} data-testid="request-open">
                    <div className="flex items-center gap-2"><span className="font-semibold truncate" data-testid="request-card-title">{it.title}</span><Badge tone={STATUS_TONE[it.status]}>{STATUS_LABELS[it.status]}</Badge></div>
                    {it.detail && <p className="text-sm text-label-2 whitespace-pre-line line-clamp-3 mt-1.5">{it.detail}</p>}
                    {it.example && <p className="text-xs text-label-3 whitespace-pre-line line-clamp-2 mt-1.5">例：{it.example}</p>}
                  </button>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="text-xs text-label-3 tabular whitespace-nowrap">{fmtDateTime(it.updated_at)}</span>
                    <Select value={it.status} onChange={(e) => setStatus(it, e.target.value as Status)} className="w-28 h-8 text-sm" aria-label="状態" data-testid="request-status">
                      {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                    </Select>
                  </div>
                </div>
              </Item>
            ))}
          </AnimatePresence>
        </Stagger>
      )}

      <RequestModal state={modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(true); }} />
    </div>
  );
}

function RequestModal({ state, onClose, onSaved }: { state: { mode: "new" } | { mode: "edit"; item: Req } | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const item = state?.mode === "edit" ? state.item : null;
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [example, setExample] = useState("");
  const [status, setStatus] = useState<Status>("open");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  useEffect(() => {
    if (!state) return;
    setTitle(item?.title ?? ""); setDetail(item?.detail ?? ""); setExample(item?.example ?? ""); setStatus(item?.status ?? "open");
  }, [state, item]);

  const save = async () => {
    const t = title.trim(); if (!t) return;
    setBusy("save");
    try {
      const body = { title: t, detail: detail.trim() || null, example: example.trim() || null, status };
      if (item) await api.patch(`/requests/${item.id}`, body); else await api.post("/requests", body);
      toast("保存しました", "success"); onSaved();
    } catch { toast("保存できませんでした", "error"); } finally { setBusy(null); }
  };
  const remove = async () => {
    if (!item) return;
    setBusy("delete");
    try { await api.del(`/requests/${item.id}`); toast("削除しました"); onSaved(); }
    catch { toast("削除できませんでした", "error"); } finally { setBusy(null); }
  };

  return (
    <Modal open={Boolean(state)} onClose={onClose} title={item ? "リクエストを編集" : "リクエストを追加"} footer={<>
      {item && <Button variant="danger" onClick={remove} loading={busy === "delete"} data-testid="request-delete">削除</Button>}
      <div className="flex-1" />
      <Button onClick={onClose}>キャンセル</Button>
      <Button variant="primary" onClick={save} loading={busy === "save"} disabled={!title.trim()} data-testid="request-save">保存</Button>
    </>}>
      <div className="space-y-4" data-testid="request-modal">
        <Field label="タイトル"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：カード利用の月次グラフがほしい" data-testid="request-title" autoFocus /></Field>
        <Field label="詳細"><Textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="困っていること、こうなってほしいこと" data-testid="request-detail" /></Field>
        <Field label="具体例"><Textarea value={example} onChange={(e) => setExample(e.target.value)} placeholder="画面や操作の例" className="min-h-16" data-testid="request-example" /></Field>
        <Field label="状態">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Status)} data-testid="request-modal-status">
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
