import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import type { LifeContext, PressureAssessment } from "@shared/types";
import { api, useApi, fmtYen, fmtNum, fmtDate, fmtDateTime } from "@/lib/api";
import { Badge, Button, Card, Input, PageSkeleton, Stat, EmptyState, ErrorBanner, cx, useToast } from "@/components/ui";

type Dash = {
  context: LifeContext; suggestion: string; today: string;
  weather: { temperature: number | null; weather_label: string | null; precipitation_probability: number | null; pressure: PressureAssessment; pressure_series: { time: string; hpa: number | null }[]; location: { name: string } } | null;
  weatherError: string | null; weatherConfigured: boolean;
  tasks: { id: string; title: string; date: string | null }[];
  events: { id: string; title: string; start_at: string; end_at: string | null }[];
  fxPairs: { pair: string; bid: number; ask: number; quoted_at: string }[];
  layout: unknown;
};

/* ---------- Card layout (settings key `dashboard_layout`) ---------- */
export const CARD_IDS = ["clock", "weather", "health", "tasks", "events", "cards", "fx"] as const;
export type CardId = (typeof CARD_IDS)[number];
export type LayoutEntry = { id: CardId; hidden?: boolean };
const CARD_LABEL: Record<CardId, string> = { clock: "時計・提案", weather: "天気・気圧", health: "健康", tasks: "タスク", events: "今週の予定", cards: "カード利用", fx: "FX" };
/** Saved order first (unknown ids dropped), then any card missing from the saved list in default order. */
export function normalizeLayout(raw: unknown): LayoutEntry[] {
  const out: LayoutEntry[] = []; const seen = new Set<string>();
  if (Array.isArray(raw)) for (const e of raw) {
    const id = typeof e === "string" ? e : e && typeof e === "object" ? (e as any).id : null;
    if (!(CARD_IDS as readonly string[]).includes(id) || seen.has(id)) continue;
    seen.add(id); out.push({ id, hidden: Boolean(typeof e === "object" && e && (e as any).hidden) });
  }
  for (const id of CARD_IDS) if (!seen.has(id)) out.push({ id, hidden: false });
  return out;
}

function Clock({ weather }: { weather?: string | null }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  const jst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60000);
  const w = ["日", "月", "火", "水", "木", "金", "土"][jst.getDay()];
  return (
    <div>
      <div className="text-5xl md:text-6xl font-semibold tracking-tight tabular" data-testid="clock">{String(jst.getHours()).padStart(2, "0")}:{String(jst.getMinutes()).padStart(2, "0")}<span className="text-label-3 text-2xl ml-1">{String(jst.getSeconds()).padStart(2, "0")}</span></div>
      <div className="text-label-2 mt-1">{jst.getFullYear()}年{jst.getMonth() + 1}月{jst.getDate()}日（{w}）JST</div>
      {weather && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-label-2 mt-2 truncate" data-testid="clock-weather">{weather}</motion.div>}
    </div>
  );
}

const levelTone: Record<PressureAssessment["level"], "neutral" | "orange" | "red" | "green"> = { stable: "green", caution: "orange", strong: "red", unknown: "neutral" };
const levelLabel: Record<PressureAssessment["level"], string> = { stable: "安定", caution: "注意", strong: "強い変化", unknown: "判定不可" };
const sec = (s: number | null | undefined) => s == null ? "—" : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;

export default function Page() {
  const { data, loading, error, reload, setData } = useApi<Dash>("/dashboard", { poll: 60000 });
  const toast = useToast();
  const [newTask, setNewTask] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LayoutEntry[] | null>(null);
  // Keyed on the serialized value so a poll/refresh with equal content keeps the same identity (no needless layout work).
  const layoutKey = JSON.stringify(data?.layout ?? null);
  const savedLayout = useMemo(() => normalizeLayout(JSON.parse(layoutKey)), [layoutKey]);
  const layout = editing && draft ? draft : savedLayout;
  useEffect(() => { document.title = "Life OS｜ダッシュボード"; }, []);
  // Quick actions from the command palette (and other global writes) ask open pages to refresh.
  useEffect(() => { const h = () => reload(true); window.addEventListener("lifeos:refresh", h); return () => window.removeEventListener("lifeos:refresh", h); }, [reload]);
  if (loading && !data) return <PageSkeleton cards={6} />;
  if (!data) return <div><ErrorBanner message={error} onRetry={() => reload()} testId="dash-error" /><EmptyState title="ダッシュボードを読み込めませんでした" /></div>;
  const ctx = data.context; const o = ctx.health.oura; const w = data.weather;
  const weatherLine = w ? [w.location.name, w.temperature != null ? `${fmtNum(w.temperature, 1)}°` : null, w.weather_label, w.precipitation_probability != null ? `雨 ${w.precipitation_probability}%` : null, w.pressure.level !== "unknown" ? `気圧 ${levelLabel[w.pressure.level]}` : null].filter(Boolean).join(" · ") : null;
  const addTask = async () => { const t = newTask.trim(); if (!t) return; await api.post("/planner", { type: "task", title: t }); setNewTask(""); toast("タスクを追加しました", "success"); reload(true); };
  const toggleTask = async (id: string) => { await api.patch(`/planner/${id}`, { done: true }); reload(true); };

  const startEdit = () => { setDraft(savedLayout.map((e) => ({ ...e }))); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setDraft(null); };
  const move = (id: CardId, dir: -1 | 1) => setDraft((d) => {
    if (!d) return d; const i = d.findIndex((e) => e.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= d.length) return d;
    const n = d.slice(); [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const setHidden = (id: CardId, hidden: boolean) => setDraft((d) => d ? d.map((e) => (e.id === id ? { ...e, hidden } : e)) : d);
  const finishEdit = async () => {
    const next = draft ?? savedLayout;
    try {
      await api.put("/settings/dashboard_layout", next);
      setData((cur) => (cur ? { ...cur, layout: next } : cur));
      setEditing(false); setDraft(null);
      toast("配置を保存しました", "success");
    } catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); }
  };
  const visible = layout.filter((e) => !e.hidden);
  const hiddenEntries = layout.filter((e) => e.hidden);
  const span: Partial<Record<CardId, string>> = { clock: "md:col-span-2 xl:col-span-2" };

  const cardBody: Record<CardId, ReactNode> = {
    clock: (
      <Card className="h-full flex flex-col justify-between gap-6">
        <Clock weather={weatherLine} />
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="text-lg leading-relaxed text-label" data-testid="suggestion">{data.suggestion}</motion.p>
      </Card>
    ),
    weather: (
      <Card className="h-full">
        <div className="flex items-start justify-between"><div className="text-xs font-medium text-label-2">天気・気圧</div>{w && <Badge tone={levelTone[w.pressure.level]}>{levelLabel[w.pressure.level]}</Badge>}</div>
        {!data.weatherConfigured && <div className="mt-3 text-sm text-label-2">地域が未設定です。<Link to="/settings#weather" className="focus-ring rounded-[var(--radius-sm)] text-accent">設定で市区町村を選ぶ</Link></div>}
        {data.weatherError && <div className="mt-3 text-sm text-red">天気を取得できませんでした</div>}
        {w && (<>
          <div className="mt-2 flex items-baseline gap-3"><span className="text-3xl font-semibold tabular">{w.temperature != null ? `${fmtNum(w.temperature, 1)}°` : "—"}</span><span className="text-label-2">{w.weather_label ?? "—"}</span><span className="text-label-2 text-sm">雨 {w.precipitation_probability ?? "—"}%</span></div>
          <div className="text-xs text-label-3 mt-1">{w.location.name}</div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
            <div><div className="text-label-2 text-xs">現在</div><div className="tabular font-medium">{w.pressure.current != null ? `${fmtNum(w.pressure.current, 1)} hPa` : "—"}</div></div>
            <div><div className="text-label-2 text-xs">3時間</div><div className={cx("tabular font-medium", w.pressure.delta3h != null && Math.abs(w.pressure.delta3h) >= 2.5 && "text-orange")}>{w.pressure.delta3h != null ? `${w.pressure.delta3h > 0 ? "+" : ""}${fmtNum(w.pressure.delta3h, 1)}` : "—"}</div></div>
            <div><div className="text-label-2 text-xs">6時間</div><div className={cx("tabular font-medium", w.pressure.delta6h != null && Math.abs(w.pressure.delta6h) >= 4 && "text-orange")}>{w.pressure.delta6h != null ? `${w.pressure.delta6h > 0 ? "+" : ""}${fmtNum(w.pressure.delta6h, 1)}` : "—"}</div></div>
          </div>
          <Sparkline series={w.pressure_series} />
        </>)}
      </Card>
    ),
    health: (
      <Card className="h-full">
        <div className="flex items-start justify-between"><div className="text-xs font-medium text-label-2">健康</div>{o && <Badge tone={ctx.health.oura_is_today ? "green" : "neutral"}>{ctx.health.oura_is_today ? "今日" : `${fmtDate(o.day)} の値`}</Badge>}</div>
        {!o && <div className="mt-3 text-sm text-label-2">Ouraのデータがありません。<Link to="/settings#integrations" className="focus-ring rounded-[var(--radius-sm)] text-accent">接続する</Link></div>}
        {o && (<div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="睡眠" value={sec(o.sleep_duration_sec)} hint={`スコア ${o.sleep_score ?? "—"}`} />
          <Stat label="コンディション" value={o.readiness_score ?? "—"} />
          <Stat label="歩数" value={fmtNum(o.steps)} />
          <Stat label="睡眠バランス" value={o.sleep_balance ?? "—"} hint="0〜100のスコア" />
        </div>)}
        <div className="mt-4 text-sm text-label-2">{ctx.training.trained_today ? "今日は筋トレ記録済み" : ctx.training.last_session ? `前回: ${ctx.training.last_session.part}（${fmtDateTime(ctx.training.last_session.started_at)}）` : "トレーニング記録なし"}</div>
        <CardLink to="/health">健康を開く</CardLink>
      </Card>
    ),
    tasks: (
      <Card className="h-full flex flex-col">
        <div className="flex items-center justify-between"><div className="text-xs font-medium text-label-2">タスク</div><Badge>{ctx.planner.tasks_open}</Badge></div>
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); addTask(); }}>
          <Input value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder="タスクを追加" data-testid="dash-task-input" />
          <Button type="submit" variant="tinted" disabled={!newTask.trim()} data-testid="dash-task-add">追加</Button>
        </form>
        <ul className="mt-3 space-y-1 flex-1 max-h-72 overflow-auto" data-testid="dash-task-list">
          {data.tasks.length === 0 && <li className="text-sm text-label-3 py-3 text-center">未完了タスクはありません</li>}
          {data.tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-1.5 group">
              <button type="button" aria-label={`「${t.title}」を完了にする`} onClick={() => toggleTask(t.id)} className="focus-ring group/done -m-2 p-2 rounded-full shrink-0"><span aria-hidden className="block size-5 rounded-full border border-label-3 group-hover/done:border-accent group-hover/done:bg-accent-soft transition-colors" /></button>
              <span className="flex-1 text-sm truncate">{t.title}</span>
              {t.date && <span className="text-xs text-label-3 tabular">{fmtDate(t.date)}</span>}
            </li>
          ))}
        </ul>
        <CardLink to="/planner">スケジュールを開く</CardLink>
      </Card>
    ),
    events: (
      <Card className="h-full">
        <div className="text-xs font-medium text-label-2">今週の予定</div>
        <ul className="mt-3 space-y-2">
          {data.events.length === 0 && <li className="text-sm text-label-3 py-3 text-center">今日から1週間の予定はありません</li>}
          {data.events.map((e) => (<li key={e.id} className="flex gap-3 text-sm"><span className="tabular text-label-2 w-24 shrink-0">{fmtDateTime(e.start_at)}</span><span className="truncate">{e.title}</span></li>))}
        </ul>
      </Card>
    ),
    cards: (
      <Card className="h-full">
        <div className="text-xs font-medium text-label-2">カード利用</div>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <Stat label="今月の利用累計" value={fmtYen(ctx.money.card_month_total)} />
          <Stat label="月予算の残り" value={fmtYen(ctx.money.card_budget_left)} tone={ctx.money.card_budget_left != null && ctx.money.card_budget_left < 0 ? "red" : undefined} hint={ctx.money.card_budget == null ? "予算未設定" : undefined} />
        </div>
        <CardLink to="/cards">カード利用を開く</CardLink>
      </Card>
    ),
    fx: (
      <Card className="h-full">
        <div className="flex items-center justify-between"><div className="text-xs font-medium text-label-2">FX</div><Badge tone={ctx.fx.connector_online ? "green" : "neutral"}>{ctx.fx.connector_online ? "接続中" : "更新待ち"}</Badge></div>
        <div className="mt-3 text-sm text-label-2">保有 {ctx.fx.open_positions} 組</div>
        <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {data.fxPairs.length === 0 && <li className="text-label-3 col-span-2">価格未受信</li>}
          {data.fxPairs.map((p) => <li key={p.pair} className="flex justify-between"><span>{p.pair}</span><span className="tabular text-right">{p.bid}</span></li>)}
        </ul>
        <CardLink to="/fx">FXシグナルを開く</CardLink>
      </Card>
    ),
  };

  return (
    <div>
      {error && <ErrorBanner message={error} onRetry={() => reload()} testId="dash-error" />}
      <div className="flex items-center justify-end gap-2 mb-3 min-h-8">
        <AnimatePresence initial={false}>
          {editing && hiddenEntries.length > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-wrap items-center gap-1.5 mr-auto" data-testid="dash-hidden">
              <span className="text-xs text-label-3">非表示:</span>
              {hiddenEntries.map((e) => (
                <button key={e.id} type="button" onClick={() => setHidden(e.id, false)} data-testid={`dash-card-show-${e.id}`} className="pressable focus-ring rounded-full bg-fill px-3 h-8 text-sm text-label-2 hover:text-label" aria-label={`${CARD_LABEL[e.id]}を表示に戻す`}>{CARD_LABEL[e.id]} ＋</button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        {editing && <Button size="sm" variant="ghost" onClick={cancelEdit} data-testid="dash-edit-cancel">キャンセル</Button>}
        <Button size="sm" variant={editing ? "primary" : "ghost"} onClick={editing ? finishEdit : startEdit} data-testid="dash-edit">{editing ? "完了" : "編集"}</Button>
      </div>
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 auto-rows-min">
        <AnimatePresence initial={false}>
          {visible.map((e, i) => (
            <motion.div key={e.id} layout={editing} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}
              className={cx("relative", span[e.id])} data-testid={`dash-card-${e.id}`}>
              {editing && (
                <div className="absolute top-2 right-2 z-10 flex items-center gap-1 glass rounded-full px-1 h-8 shadow-[var(--shadow-card)]" data-testid={`dash-card-controls-${e.id}`}>
                  <button type="button" aria-label={`${CARD_LABEL[e.id]}を上へ`} disabled={i === 0} onClick={() => move(e.id, -1)} data-testid={`dash-card-up-${e.id}`} className="focus-ring size-7 rounded-full grid place-items-center text-sm text-label-2 hover:bg-fill disabled:opacity-30">↑</button>
                  <button type="button" aria-label={`${CARD_LABEL[e.id]}を下へ`} disabled={i === visible.length - 1} onClick={() => move(e.id, 1)} data-testid={`dash-card-down-${e.id}`} className="focus-ring size-7 rounded-full grid place-items-center text-sm text-label-2 hover:bg-fill disabled:opacity-30">↓</button>
                  <button type="button" onClick={() => setHidden(e.id, true)} data-testid={`dash-card-hide-${e.id}`} aria-label={`${CARD_LABEL[e.id]}を非表示にする`} className="focus-ring h-7 rounded-full px-2 text-xs text-label-2 hover:bg-fill">非表示</button>
                </div>
              )}
              <div className={cx("h-full", editing && "pointer-events-none select-none opacity-90")}>{cardBody[e.id]}</div>
            </motion.div>
          ))}
        </AnimatePresence>
        {visible.length === 0 && <div className="col-span-full"><EmptyState title="すべてのカードが非表示です" hint="上の非表示チップから戻せます" /></div>}
      </div>
    </div>
  );
}

function CardLink({ to, children }: { to: string; children: string }) {
  return <Link to={to} className="focus-ring rounded-[var(--radius-sm)] text-accent text-sm mt-3 inline-block self-start">{children}</Link>;
}

function Sparkline({ series }: { series: { time: string; hpa: number | null }[] }) {
  const pts = series.filter((s) => s.hpa != null) as { time: string; hpa: number }[];
  if (pts.length < 2) return null;
  const min = Math.min(...pts.map((p) => p.hpa)), max = Math.max(...pts.map((p) => p.hpa));
  const W = 300, H = 48;
  const d = pts.map((p, i) => `${(i / (pts.length - 1)) * W},${H - ((p.hpa - min) / Math.max(1, max - min)) * (H - 6) - 3}`).join(" ");
  return <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12 mt-3 text-accent" preserveAspectRatio="none" aria-hidden><motion.polyline initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1 }} fill="none" stroke="currentColor" strokeWidth="2" points={d} /></svg>;
}
