import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { api, useApi, fmtDateTime } from "@/lib/api";
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Item, Modal, PageHeader, PageSkeleton, Segmented, Select, Stagger, Textarea, Input, Toggle, useToast, cx } from "@/components/ui";

type IdeaStatus = "inbox" | "someday" | "next" | "done";
type Idea = { id: string; raw_text: string; title: string | null; markdown: string | null; status: IdeaStatus; organized_at: string | null; archived_at: string | null; created_at: string; updated_at: string };
type Filter = "all" | IdeaStatus;

const STATUS_LABELS: Record<IdeaStatus, string> = { inbox: "未整理", someday: "いつか", next: "次にやる", done: "完了" };
const STATUS_TONE: Record<IdeaStatus, "neutral" | "accent" | "green" | "orange"> = { inbox: "neutral", someday: "orange", next: "accent", done: "green" };
const STATUS_OPTIONS = (Object.keys(STATUS_LABELS) as IdeaStatus[]).map((v) => ({ value: v, label: STATUS_LABELS[v] }));

const displayTitle = (i: Idea) => i.title || (i.raw_text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "無題のアイデア").slice(0, 40);
const slugFilename = (title: string) => `${title.normalize("NFC").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "idea"}.md`;

export default function Page() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [archived, setArchived] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Idea | null>(null);
  const [firstLoad, setFirstLoad] = useState(true);

  const query = `/ideas?${filter !== "all" ? `status=${filter}&` : ""}${archived ? "archived=1" : ""}`;
  const { data, loading, error, reload } = useApi<{ items: Idea[] }>(query);
  useEffect(() => { if (!loading && data) setFirstLoad(false); }, [loading, data]);

  const save = async () => {
    const raw_text = draft.trim(); if (!raw_text) return;
    setSaving(true);
    try { await api.post("/ideas", { raw_text }); setDraft(""); toast("保存しました", "success"); reload(true); }
    catch { toast("保存できませんでした", "error"); }
    finally { setSaving(false); }
  };
  const close = useCallback(() => setSelected(null), []);
  const onChanged = (item: Idea | null) => { setSelected(item); reload(true); };

  const items = data?.items ?? [];
  if (firstLoad && loading) return <PageSkeleton />;
  return (
    <div>
      <PageHeader title="アイデア" subtitle="思いついたことをそのまま残し、必要なときにAIで整理してObsidianへ。" actions={
        <a href="/api/ideas/export" download="ideas-export.md" className="pressable focus-ring inline-flex items-center h-10 px-4 rounded-[var(--radius-md)] bg-fill text-label text-base font-medium whitespace-nowrap hover:bg-fill-strong" data-testid="idea-export">一括エクスポート</a>
      } />

      {error && !data && <ErrorBanner message={error} onRetry={() => reload()} testId="load-error" />}
      <Card className="mb-6">
        <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="思いついたことを、そのまま書く。" aria-label="アイデア" data-testid="idea-compose"
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save(); }} />
        <div className="flex items-center justify-between mt-3 gap-3">
          <span className="text-xs text-label-3">原文はそのまま保存されます。整理はあとからでも。</span>
          <Button variant="primary" onClick={save} loading={saving} disabled={!draft.trim()} data-testid="idea-save">保存</Button>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <Segmented value={filter} onChange={setFilter} options={[{ value: "all" as Filter, label: "すべて" }, ...STATUS_OPTIONS]} />
        <label className="flex items-center gap-2 text-sm text-label-2" data-testid="idea-archived-toggle">アーカイブ<Toggle checked={archived} onChange={setArchived} label="アーカイブを表示" /></label>
      </div>

      {error && !data ? null : items.length === 0 ? (
        <EmptyState title={archived ? "アーカイブはありません" : "アイデアはまだありません"} hint={archived ? undefined : "上の欄に書いて保存すると、ここに並びます。"} />
      ) : (
        <Stagger className="space-y-2" key={query}>
          <AnimatePresence initial={false}>
            {items.map((it) => (
              <Item key={it.id}>
                <Card onClick={() => setSelected(it)} className={cx("flex items-start gap-3", it.archived_at && "opacity-70")}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium truncate" data-testid="idea-card-title">{displayTitle(it)}</span>
                      <Badge tone={STATUS_TONE[it.status]}>{STATUS_LABELS[it.status]}</Badge>
                      {it.organized_at && <Badge tone="purple">整理済み</Badge>}
                    </div>
                    <p className="text-sm text-label-2 line-clamp-2 mt-1 whitespace-pre-line">{it.raw_text}</p>
                  </div>
                  <span className="text-xs text-label-3 shrink-0 tabular">{fmtDateTime(it.updated_at)}</span>
                </Card>
              </Item>
            ))}
          </AnimatePresence>
        </Stagger>
      )}

      <IdeaModal idea={selected} onClose={close} onChanged={onChanged} />
    </div>
  );
}

function IdeaModal({ idea, onClose, onChanged }: { idea: Idea | null; onClose: () => void; onChanged: (item: Idea | null) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [status, setStatus] = useState<IdeaStatus>("inbox");
  const [busy, setBusy] = useState<"organize" | "save" | "archive" | null>(null);
  const [provider, setProvider] = useState<string | null>(null);

  useEffect(() => {
    if (!idea) return;
    setTitle(idea.title ?? ""); setMarkdown(idea.markdown ?? ""); setStatus(idea.status); setProvider(null);
  }, [idea?.id, idea?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!idea) return <Modal open={false} onClose={onClose}><div /></Modal>;
  const dirty = title !== (idea.title ?? "") || markdown !== (idea.markdown ?? "") || status !== idea.status;

  const organize = async () => {
    setBusy("organize");
    try {
      const r = await api.post<{ item: Idea; provider: string }>(`/ideas/${idea.id}/organize`);
      setProvider(r.provider); setTitle(r.item.title ?? ""); setMarkdown(r.item.markdown ?? ""); onChanged(r.item);
      toast(r.provider === "fallback" ? "AI未接続のため原文をそのまま整形しました" : "整理しました", r.provider === "fallback" ? "neutral" : "success");
    } catch { toast("整理できませんでした", "error"); } finally { setBusy(null); }
  };
  const save = async (patch?: Partial<{ status: IdeaStatus }>) => {
    setBusy("save");
    try {
      const r = await api.patch<{ item: Idea }>(`/ideas/${idea.id}`, { title: title.trim() || null, markdown: markdown || null, status, ...patch });
      onChanged(r.item); toast("保存しました", "success");
    } catch { toast("保存できませんでした", "error"); } finally { setBusy(null); }
  };
  const archive = async (flag: boolean) => {
    setBusy("archive");
    try { await api.patch(`/ideas/${idea.id}`, { archived: flag }); toast(flag ? "アーカイブしました" : "戻しました"); onChanged(null); }
    catch { toast("更新できませんでした", "error"); } finally { setBusy(null); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(markdown || idea.raw_text); toast("コピーしました", "success"); }
    catch { toast("コピーできませんでした", "error"); }
  };
  const download = () => {
    const name = slugFilename(title.trim() || displayTitle(idea));
    const blob = new Blob([markdown || idea.raw_text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Modal open onClose={onClose} title="アイデア" wide footer={<>
      {idea.archived_at
        ? <Button onClick={() => archive(false)} loading={busy === "archive"} data-testid="idea-unarchive">アーカイブから戻す</Button>
        : <Button variant="danger" onClick={() => archive(true)} loading={busy === "archive"} data-testid="idea-archive">アーカイブ</Button>}
      <div className="flex-1" />
      <Button onClick={onClose}>閉じる</Button>
      <Button variant="primary" onClick={() => save()} loading={busy === "save"} disabled={!dirty} data-testid="idea-save-edit">保存</Button>
    </>}>
      <div className="space-y-4" data-testid="idea-modal">
        <div>
          <div className="text-xs font-medium text-label-2 mb-1.5">原文 <span className="text-label-3 font-normal">{fmtDateTime(idea.created_at)}</span></div>
          <div className="rounded-[var(--radius-md)] bg-subtle p-3 text-sm whitespace-pre-wrap leading-relaxed max-h-40 overflow-auto" data-testid="idea-raw">{idea.raw_text}</div>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Button variant="tinted" onClick={organize} loading={busy === "organize"} data-testid="idea-organize">AIで整理</Button>
          <Button onClick={copy} data-testid="idea-copy">Markdownをコピー</Button>
          <Button onClick={download} data-testid="idea-download">ダウンロード</Button>
          {provider === "fallback" && <span data-testid="idea-ai-offline"><Badge tone="orange">AI未接続</Badge></span>}
          {idea.organized_at && provider !== "fallback" && <span className="text-xs text-label-3">整理 {fmtDateTime(idea.organized_at)}</span>}
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
          <Field label="タイトル"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={displayTitle(idea)} data-testid="idea-title" /></Field>
          <Field label="状態">
            <Select value={status} onChange={(e) => setStatus(e.target.value as IdeaStatus)} data-testid="idea-status">
              {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Markdown" hint="front matter（title / created / status / tags）付きでObsidianにそのまま取り込めます。">
          <Textarea value={markdown} onChange={(e) => setMarkdown(e.target.value)} className="min-h-64 font-mono text-sm" placeholder="「AIで整理」を押すか、ここに直接書けます。" data-testid="idea-markdown" />
        </Field>
      </div>
    </Modal>
  );
}
