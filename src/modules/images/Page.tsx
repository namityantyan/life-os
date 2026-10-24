import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api, ApiError, useApi, fmtDateTime } from "@/lib/api";
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, Item, Modal, PageHeader, PageSkeleton, Segmented, Skeleton, Stagger, cx, useToast } from "@/components/ui";
import { IMAGE_COUNT_MAX, IMAGE_RATING_LABELS, IMAGE_STATUS_LABELS, type ImageFile, type ImageGeneration, type ImageRating, type ImageServiceStatus } from "@shared/images";

type History = { items: ImageGeneration[] };
type Selected = { gen: ImageGeneration; file: ImageFile };
const POLL_MS = 3000;
const isPending = (g: ImageGeneration) => g.status === "queued" || g.status === "running";
const fileUrl = (f: ImageFile) => `/api/images/files/${f.id}`;

export default function Page() {
  const toast = useToast();
  const status = useApi<{ status: ImageServiceStatus }>("/images/status", { poll: 30_000 });
  const history = useApi<History>("/images");
  const [text, setText] = useState("");
  const [count, setCount] = useState("1");
  const [rating, setRating] = useState<ImageRating>("all_ages");
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [jobsOffline, setJobsOffline] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  const items = history.data?.items ?? [];
  const svc = status.data?.status;
  const online = svc?.state === "online";

  // Poll in-progress jobs (they live in the DB, so a reload picks them up again).
  const pendingIds = items.filter(isPending).map((g) => g.id).join(",");
  useEffect(() => {
    if (!pendingIds) { setJobsOffline(false); return; }
    let stop = false;
    const tick = async () => {
      const res = await Promise.all(pendingIds.split(",").map((id) => api.get<{ item: ImageGeneration; offline: boolean }>(`/images/jobs/${id}`).catch(() => null)));
      if (stop) return;
      setJobsOffline(res.some((r) => r?.offline));
      const byId = new Map(res.filter((r): r is { item: ImageGeneration; offline: boolean } => Boolean(r)).map((r) => [r.item.id, r.item]));
      for (const g of byId.values()) if (g.status === "done") toast(`${g.files.length}枚できました`, "success"); else if (g.status === "error") toast("生成に失敗しました", "error");
      history.setData((d) => (d ? { items: d.items.map((g) => byId.get(g.id) ?? g) } : d));
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIds]);

  const generate = async () => {
    const t = text.trim(); if (!t || busy || !online) return;
    setBusy(true); setRefusal(null);
    try {
      const body: Record<string, unknown> = { text: t, count: Number(count), rating };
      if (seed.trim()) body.seed = Number(seed);
      const r = await api.post<{ item: ImageGeneration }>("/images/generate", body);
      history.setData((d) => ({ items: [r.item, ...(d?.items ?? [])] }));
      setText("");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "生成を始められませんでした";
      if (e instanceof ApiError && e.status === 422) setRefusal(msg);
      else { toast(msg, "error"); if (e instanceof ApiError && e.status === 503) status.reload(true); }
    } finally { setBusy(false); taRef.current?.focus(); }
  };

  const removeGen = async (g: ImageGeneration) => {
    try { await api.del(`/images/${g.id}`); history.setData((d) => (d ? { items: d.items.filter((x) => x.id !== g.id) } : d)); }
    catch { toast("削除できませんでした", "error"); }
  };
  const removeFile = async (s: Selected) => {
    try {
      await api.del(`/images/files/${s.file.id}`);
      history.setData((d) => (d ? { items: d.items.map((g) => (g.id === s.gen.id ? { ...g, files: g.files.filter((f) => f.id !== s.file.id) } : g)).filter((g) => g.status !== "done" || g.files.length > 0) } : d));
      setSelected(null); toast("削除しました");
    } catch { toast("削除できませんでした", "error"); }
  };

  if ((history.loading && !history.data) || (status.loading && !status.data)) return <PageSkeleton />;
  const pending = items.filter(isPending);
  const failed = items.filter((g) => g.status === "error");
  const tiles = items.filter((g) => g.status === "done").flatMap((g) => g.files.map((f) => ({ gen: g, file: f })));
  const seedValid = !seed.trim() || /^\d{1,10}$/.test(seed.trim());

  return (
    <div>
      <PageHeader title="画像生成" subtitle="文章から画像を作ります。生成はMacで行うため、Macが起動しているときだけ使えます。"
        actions={svc && <Badge tone={online ? "green" : "neutral"}>{online ? "接続中" : svc.state === "unconfigured" ? "未設定" : "オフライン"}</Badge>} />

      {history.error && !history.data && <ErrorBanner message={history.error} onRetry={() => history.reload()} testId="load-error" />}

      <AnimatePresence initial={false}>
        {svc && !online && (
          <motion.div key="offline" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <Card className="mb-5 flex flex-wrap items-center gap-3" data-testid="images-offline">
              <div className="flex-1 min-w-0"><div className="font-semibold">{svc.state === "unconfigured" ? "画像生成は未設定です" : "Macに接続できません"}</div><div className="text-sm text-label-2 mt-0.5">{svc.message}{svc.state !== "unconfigured" && " 過去の画像はこのまま見られます。"}</div></div>
              <Button size="sm" onClick={() => status.reload()} loading={status.loading} data-testid="images-recheck">再確認</Button>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <Card className="mb-6 space-y-3" data-testid="images-composer">
        <form onSubmit={(e) => { e.preventDefault(); generate(); }} className="space-y-3">
          <textarea ref={taRef} value={text} onChange={(e) => { setText(e.target.value); setRefusal(null); }} placeholder="例：花畑で白いワンピースの女の子が微笑んでいる" aria-label="作りたい画像" data-testid="images-prompt"
            className="focus-ring block w-full min-h-28 px-3 py-2 leading-6 resize-y rounded-[var(--radius-md)] bg-fill text-label placeholder:text-label-3 outline-none transition-[box-shadow] focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return; // IME confirm → no send
              if (e.metaKey || e.ctrlKey) { e.preventDefault(); generate(); }
            }} />
          <AnimatePresence initial={false}>
            {refusal && <motion.div key="refusal" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} role="alert" className="text-sm text-red" data-testid="images-refused">{refusal}</motion.div>}
          </AnimatePresence>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5"><div className="text-xs font-medium text-label-2">枚数</div><Segmented value={count} onChange={setCount} testId="images-count" options={Array.from({ length: IMAGE_COUNT_MAX }, (_, i) => ({ value: String(i + 1), label: `${i + 1}枚` }))} /></div>
            <div className="space-y-1.5"><div className="text-xs font-medium text-label-2">区分</div><Segmented value={rating} onChange={setRating} testId="images-rating" options={(["all_ages", "r18"] as const).map((r) => ({ value: r, label: IMAGE_RATING_LABELS[r] }))} /></div>
            <Field label="シード" className="w-36"><Input value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" placeholder="ランダム" aria-label="シード" data-testid="images-seed" className="h-9" /></Field>
            <div className="flex-1" />
            <div className="flex flex-col items-end gap-1">
              <Button type="submit" variant="primary" loading={busy} disabled={!text.trim() || !online || !seedValid} data-testid="images-generate">生成</Button>
              <span className="text-[0.6875rem] text-label-3 hidden sm:block">Enterで改行・{isMac ? "⌘" : "Ctrl"}＋Enterで生成</span>
            </div>
          </div>
        </form>
      </Card>

      {jobsOffline && pending.length > 0 && <p className="text-sm text-label-2 mb-3" data-testid="images-jobs-offline">Macに接続できないため、進み具合を確認できません。つながると続きから受け取ります。</p>}

      {failed.length > 0 && (
        <div className="space-y-2 mb-5">
          {failed.map((g) => (
            <div key={g.id} className="flex items-center gap-3 rounded-[var(--radius-lg)] bg-red/10 px-4 py-2.5 text-sm" data-testid="images-failed">
              <span className="flex-1 min-w-0"><span className="text-red font-medium">失敗</span><span className="text-label-2 ml-2 break-words">{g.error ?? "生成に失敗しました"}</span><span className="block text-xs text-label-3 truncate mt-0.5">{g.prompt_text}</span></span>
              <Button size="sm" variant="ghost" onClick={() => removeGen(g)}>閉じる</Button>
            </div>
          ))}
        </div>
      )}

      {pending.length === 0 && tiles.length === 0 ? (
        <EmptyState title="まだ画像はありません" hint="作りたい画像を文章で書いて生成してください。" />
      ) : (
        <Stagger className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          <AnimatePresence initial={false}>
            {pending.flatMap((g) => Array.from({ length: g.count }, (_, i) => (
              <Item key={`${g.id}-p${i}`}>
                <div className="relative aspect-[3/4] rounded-[var(--radius-lg)] overflow-hidden" data-testid="images-pending">
                  <Skeleton className="absolute inset-0 rounded-none" />
                  <div className="absolute inset-x-0 bottom-0 p-2.5 text-xs text-label-2 tabular">{g.status === "running" ? `${IMAGE_STATUS_LABELS.running} ${Math.min(g.progress_done, g.count)}/${g.count}` : g.queue_position && g.queue_position > 1 ? `${IMAGE_STATUS_LABELS.queued}（${g.queue_position}番目）` : IMAGE_STATUS_LABELS.queued}</div>
                </div>
              </Item>
            )))}
            {tiles.map((t) => (
              <Item key={t.file.id}>
                <button className="block w-full aspect-[3/4] rounded-[var(--radius-lg)] overflow-hidden bg-fill focus-ring pressable" onClick={() => setSelected(t)} aria-label={`画像を開く：${t.gen.prompt_text}`} data-testid="images-tile">
                  <img src={fileUrl(t.file)} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                </button>
              </Item>
            ))}
          </AnimatePresence>
        </Stagger>
      )}

      <ImageModal selected={selected} onClose={() => setSelected(null)} onDelete={removeFile} onReuse={(g) => { setText(g.prompt_text); setRating(g.rating); setSelected(null); taRef.current?.focus(); }} />
    </div>
  );
}

function ImageModal({ selected, onClose, onDelete, onReuse }: { selected: Selected | null; onClose: () => void; onDelete: (s: Selected) => Promise<void>; onReuse: (g: ImageGeneration) => void }) {
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const s = selected;
  const copy = async (v: string) => { try { await navigator.clipboard.writeText(v); toast("コピーしました"); } catch { toast("コピーできませんでした", "error"); } };
  return (
    <Modal open={Boolean(s)} onClose={onClose} title="画像" wide footer={s && <>
      <Button variant="danger" loading={deleting} onClick={async () => { setDeleting(true); try { await onDelete(s); } finally { setDeleting(false); } }} data-testid="images-delete">削除</Button>
      <div className="flex-1" />
      <Button onClick={() => onReuse(s.gen)} data-testid="images-reuse">この内容で入力</Button>
      <a href={`${fileUrl(s.file)}?download=1`} download className={cx("pressable focus-ring inline-flex items-center justify-center h-10 px-4 font-medium rounded-[var(--radius-md)] bg-accent text-white hover:brightness-110")} data-testid="images-download">ダウンロード</a>
    </>}>
      {s && (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]" data-testid="images-detail">
          <div className="rounded-[var(--radius-lg)] bg-fill overflow-hidden grid place-items-center"><img src={fileUrl(s.file)} alt="" className="max-h-[64dvh] w-auto object-contain" /></div>
          <dl className="space-y-4 text-sm min-w-0">
            <div><dt className="text-xs text-label-2 font-medium">入力</dt><dd className="mt-1 whitespace-pre-wrap break-words">{s.gen.prompt_text}</dd></div>
            <div><dt className="text-xs text-label-2 font-medium flex items-center justify-between">タグ<button className="text-accent text-xs" onClick={() => copy(s.gen.tags)}>コピー</button></dt><dd className="mt-1 font-mono text-xs leading-relaxed break-words text-label-2 select-all" data-testid="images-tags">{s.gen.tags}</dd></div>
            <div className="flex gap-6">
              <div><dt className="text-xs text-label-2 font-medium">シード</dt><dd className="mt-1 tabular" data-testid="images-seed-value">{s.file.seed ?? "—"}</dd></div>
              <div><dt className="text-xs text-label-2 font-medium">区分</dt><dd className="mt-1"><Badge tone={s.gen.rating === "r18" ? "orange" : "neutral"}>{IMAGE_RATING_LABELS[s.gen.rating]}</Badge></dd></div>
            </div>
            <div><dt className="text-xs text-label-2 font-medium">作成</dt><dd className="mt-1 tabular">{fmtDateTime(s.gen.created_at)}</dd></div>
          </dl>
        </div>
      )}
    </Modal>
  );
}
