import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import type { LifeContext, PressureAssessment } from "@shared/types";
import { api, useApi, fmtYen, fmtNum, fmtDateTime } from "@/lib/api";
import { Badge, Button, Card, Input, PageSkeleton, Stagger, Item, Stat, cx, useToast } from "@/components/ui";

type Dash = {
  context: LifeContext; suggestion: string; today: string;
  weather: { temperature: number | null; weather_label: string | null; precipitation_probability: number | null; pressure: PressureAssessment; pressure_series: { time: string; hpa: number | null }[]; location: { name: string } } | null;
  weatherError: string | null; weatherConfigured: boolean;
  tasks: { id: string; title: string; date: string | null }[];
  events: { id: string; title: string; start_at: string; end_at: string | null }[];
  fxPairs: { pair: string; bid: number; ask: number; quoted_at: string }[];
};

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  const jst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60000);
  const w = ["日", "月", "火", "水", "木", "金", "土"][jst.getDay()];
  return (
    <div>
      <div className="text-5xl md:text-6xl font-semibold tracking-tight tabular" data-testid="clock">{String(jst.getHours()).padStart(2, "0")}:{String(jst.getMinutes()).padStart(2, "0")}<span className="text-label-3 text-2xl ml-1">{String(jst.getSeconds()).padStart(2, "0")}</span></div>
      <div className="text-label-2 mt-1">{jst.getFullYear()}年{jst.getMonth() + 1}月{jst.getDate()}日（{w}）JST</div>
    </div>
  );
}

const levelTone: Record<PressureAssessment["level"], "neutral" | "orange" | "red" | "green"> = { stable: "green", caution: "orange", strong: "red", unknown: "neutral" };
const levelLabel: Record<PressureAssessment["level"], string> = { stable: "安定", caution: "注意", strong: "強い変化", unknown: "判定不可" };
const sec = (s: number | null | undefined) => s == null ? "—" : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;

export default function Page() {
  const { data, loading, reload } = useApi<Dash>("/dashboard", { poll: 60000 });
  const toast = useToast();
  const [newTask, setNewTask] = useState("");
  useEffect(() => { document.title = "Life OS｜ダッシュボード"; }, []);
  if (loading && !data) return <PageSkeleton cards={6} />;
  if (!data) return null;
  const ctx = data.context; const o = ctx.health.oura; const w = data.weather;
  const addTask = async () => { const t = newTask.trim(); if (!t) return; await api.post("/planner", { type: "task", title: t }); setNewTask(""); toast("タスクを追加しました", "success"); reload(true); };
  const toggleTask = async (id: string) => { await api.patch(`/planner/${id}`, { done: true }); reload(true); };

  return (
    <Stagger className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 auto-rows-min">
      <Item className="md:col-span-2 xl:col-span-2"><Card className="h-full flex flex-col justify-between gap-6">
        <Clock />
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="text-lg leading-relaxed text-label" data-testid="suggestion">{data.suggestion}</motion.p>
      </Card></Item>

      <Item><Card className="h-full">
        <div className="flex items-start justify-between"><div className="text-xs font-medium text-label-2">天気・気圧</div>{w && <Badge tone={levelTone[w.pressure.level]}>{levelLabel[w.pressure.level]}</Badge>}</div>
        {!data.weatherConfigured && <div className="mt-3 text-sm text-label-2">地域が未設定です。<Link to="/settings#weather" className="text-accent">設定で市区町村を選ぶ</Link></div>}
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
      </Card></Item>

      <Item><Card className="h-full">
        <div className="flex items-start justify-between"><div className="text-xs font-medium text-label-2">健康</div>{o && <Badge tone={ctx.health.oura_is_today ? "green" : "neutral"}>{ctx.health.oura_is_today ? "今日" : `${o.day} の値`}</Badge>}</div>
        {!o && <div className="mt-3 text-sm text-label-2">Ouraのデータがありません。<Link to="/settings#integrations" className="text-accent">接続する</Link></div>}
        {o && (<div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="睡眠" value={sec(o.sleep_duration_sec)} hint={`スコア ${o.sleep_score ?? "—"}`} />
          <Stat label="コンディション" value={o.readiness_score ?? "—"} />
          <Stat label="歩数" value={fmtNum(o.steps)} />
          <Stat label="睡眠バランス" value={o.sleep_balance ?? "—"} hint="0〜100のスコア" />
        </div>)}
        <div className="mt-4 text-sm text-label-2">{ctx.training.trained_today ? "今日は筋トレ記録済み" : ctx.training.last_session ? `前回: ${ctx.training.last_session.part}（${fmtDateTime(ctx.training.last_session.started_at)}）` : "トレーニング記録なし"}</div>
        <Link to="/health" className="text-accent text-sm mt-2 inline-block">健康を開く</Link>
      </Card></Item>

      <Item><Card className="h-full flex flex-col">
        <div className="flex items-center justify-between"><div className="text-xs font-medium text-label-2">タスク</div><Badge>{ctx.planner.tasks_open}</Badge></div>
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); addTask(); }}>
          <Input value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder="タスクを追加" data-testid="dash-task-input" />
          <Button type="submit" variant="tinted" disabled={!newTask.trim()} data-testid="dash-task-add">追加</Button>
        </form>
        <ul className="mt-3 space-y-1 flex-1 max-h-72 overflow-auto" data-testid="dash-task-list">
          {data.tasks.length === 0 && <li className="text-sm text-label-3 py-3 text-center">未完了タスクはありません</li>}
          {data.tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-1.5 group">
              <button aria-label="完了" onClick={() => toggleTask(t.id)} className="size-5 rounded-full border border-label-3 hover:border-accent hover:bg-accent-soft transition-colors shrink-0" />
              <span className="flex-1 text-sm truncate">{t.title}</span>
              {t.date && <span className="text-xs text-label-3 tabular">{t.date.slice(5).replace("-", "/")}</span>}
            </li>
          ))}
        </ul>
        <Link to="/planner" className="text-accent text-sm mt-2">スケジュールを開く</Link>
      </Card></Item>

      <Item><Card className="h-full">
        <div className="text-xs font-medium text-label-2">今週の予定</div>
        <ul className="mt-3 space-y-2">
          {data.events.length === 0 && <li className="text-sm text-label-3 py-3 text-center">今日から1週間の予定はありません</li>}
          {data.events.map((e) => (<li key={e.id} className="flex gap-3 text-sm"><span className="tabular text-label-2 w-24 shrink-0">{fmtDateTime(e.start_at)}</span><span className="truncate">{e.title}</span></li>))}
        </ul>
      </Card></Item>

      <Item><Card className="h-full">
        <div className="text-xs font-medium text-label-2">カード利用</div>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <Stat label="今月の利用累計" value={fmtYen(ctx.money.card_month_total)} />
          <Stat label="月予算の残り" value={fmtYen(ctx.money.card_budget_left)} tone={ctx.money.card_budget_left != null && ctx.money.card_budget_left < 0 ? "red" : undefined} hint={ctx.money.card_budget == null ? "予算未設定" : undefined} />
        </div>
        <Link to="/cards" className="text-accent text-sm mt-3 inline-block">カード利用を開く</Link>
      </Card></Item>

      <Item><Card className="h-full">
        <div className="flex items-center justify-between"><div className="text-xs font-medium text-label-2">FX</div><Badge tone={ctx.fx.connector_online ? "green" : "neutral"}>{ctx.fx.connector_online ? "接続中" : "更新待ち"}</Badge></div>
        <div className="mt-3 text-sm text-label-2">保有 {ctx.fx.open_positions} 組</div>
        <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {data.fxPairs.length === 0 && <li className="text-label-3 col-span-2">価格未受信</li>}
          {data.fxPairs.map((p) => <li key={p.pair} className="flex justify-between"><span>{p.pair}</span><span className="tabular">{p.bid}</span></li>)}
        </ul>
        <Link to="/fx" className="text-accent text-sm mt-3 inline-block">FXシグナルを開く</Link>
      </Card></Item>
    </Stagger>
  );
}

function Sparkline({ series }: { series: { time: string; hpa: number | null }[] }) {
  const pts = series.filter((s) => s.hpa != null) as { time: string; hpa: number }[];
  if (pts.length < 2) return null;
  const min = Math.min(...pts.map((p) => p.hpa)), max = Math.max(...pts.map((p) => p.hpa));
  const W = 300, H = 48;
  const d = pts.map((p, i) => `${(i / (pts.length - 1)) * W},${H - ((p.hpa - min) / Math.max(1, max - min)) * (H - 6) - 3}`).join(" ");
  return <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12 mt-3 text-accent" preserveAspectRatio="none" aria-hidden><motion.polyline initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1 }} fill="none" stroke="currentColor" strokeWidth="2" points={d} /></svg>;
}
