import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { PageHeader, Card, Section, Badge, Button, Segmented, Select, Field, Input, Toggle, Stat, PageSkeleton, EmptyState, Stagger, Item, useToast, cx } from "@/components/ui";
import { api, useApi, fmtDateTime, fmtNum } from "@/lib/api";
import { PAIRS, RULES, RULE_KEYS, pipSize, type Pair, type Rule, type Timeframe, type PairsResponse, type ChartResponse, type TradeRow, type FxSettings, type StatusResponse, type PerformanceResponse, type SetupMark, type ConnectorPosition } from "@shared/fx";
import ChartView from "./ChartView";

type Tab = "pairs" | "chart" | "positions" | "trades" | "settings";
const TABS: { value: Tab; label: string; path: string }[] = [
  { value: "pairs", label: "通貨ペア", path: "/fx" }, { value: "chart", label: "チャート", path: "/fx/chart" }, { value: "positions", label: "保有・履歴", path: "/fx/positions" },
  { value: "trades", label: "履歴・成績", path: "/fx/trades" }, { value: "settings", label: "設定・接続", path: "/fx/settings" },
];

export default function Page() {
  const nav = useNavigate(); const loc = useLocation();
  const tab: Tab = TABS.find((t) => t.path !== "/fx" && loc.pathname.startsWith(t.path))?.value ?? "pairs";
  const status = useApi<StatusResponse>("/fx/status", { poll: 5000 });
  return (
    <div>
      <PageHeader title="FXシグナル" subtitle={<ConnectorBadge s={status.data} />} actions={<Segmented value={tab} onChange={(v) => nav(TABS.find((t) => t.value === v)!.path)} options={TABS.map((t) => ({ value: t.value, label: t.label }))} />} />
      <Routes>
        <Route index element={<PairsTab />} />
        <Route path="chart" element={<ChartTab />} />
        <Route path="positions" element={<PositionsTab />} />
        <Route path="trades" element={<TradesTab />} />
        <Route path="settings" element={<SettingsTab status={status.data} reloadStatus={() => status.reload(true)} />} />
      </Routes>
    </div>
  );
}

function ConnectorBadge({ s }: { s: StatusResponse | null }) {
  if (!s) return <span>—</span>;
  return (
    <span className="inline-flex items-center gap-2" data-testid="fx-connector-status">
      <span className={cx("inline-block size-2 rounded-full", s.connector_online ? "bg-green" : "bg-label-3")} />
      {s.connector_online ? `接続中 · v${s.version ?? "?"}` : s.last_seen ? `更新待ち · 最終受信 ${fmtDateTime(s.last_seen)}` : "Windows接続待ち"}
      {s.r_limit_block.blocked && <Badge tone="red">損失制限で新規停止</Badge>}
      {!s.year_config_valid && <Badge tone="orange">年度設定の期限切れ</Badge>}
    </span>
  );
}

/* ------------------------------------------------------------- 通貨ペア */
function MarkPill({ mark, enabled }: { mark: SetupMark; enabled: boolean }) {
  const base = "inline-flex items-center rounded-full px-2.5 py-1 text-sm font-semibold whitespace-nowrap";
  const cls = {
    ready_buy: "bg-accent text-white", ready_sell: "bg-red text-white",
    entry_buy: "bg-accent-soft text-accent ring-1 ring-accent/40", entry_sell: "bg-red/12 text-red ring-1 ring-red/40",
    waiting: "bg-fill text-label-2 font-medium", stale: "bg-transparent text-label-3 font-medium",
  }[mark.kind];
  return (
    <span className="inline-flex items-center gap-2 flex-wrap justify-end">
      {!enabled && <span className="text-xs text-orange">自動エントリー停止中</span>}
      <span className={cx(base, cls)} data-mark={mark.kind}>{mark.label}</span>
    </span>
  );
}

function PairsTab() {
  const { data, loading } = useApi<PairsResponse>("/fx/pairs", { poll: 5000 });
  const nav = useNavigate();
  if (loading && !data) return <PageSkeleton cards={7} />;
  if (!data) return <EmptyState title="取得できません" />;
  return (
    <div className="space-y-4">
      {!data.connector_online && (
        <Card className="text-sm text-label-2" data-testid="fx-offline-note">
          Windowsからの受信が確認できません（最終受信 {data.connector_last_seen ? fmtDateTime(data.connector_last_seen) : "なし"}）。マークは「更新待ち」になります。Windowsの起動・スリープ、MT5のログイン、コネクター、通信を確認してください。
        </Card>
      )}
      <Stagger className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {data.pairs.map((p) => {
          const digits = pipSize(p.pair) === 0.01 ? 3 : 5;
          return (
            <Item key={p.pair}>
              <Card className="h-full"><div className="space-y-3" data-testid={`fx-pair-${p.pair.replace("/", "")}`}>
                <div className="flex items-baseline justify-between">
                  <button className="text-xl font-semibold tracking-tight text-accent focus-ring rounded" onClick={() => nav(`/fx/chart?pair=${encodeURIComponent(p.pair)}`)} data-testid={`fx-pair-link-${p.pair.replace("/", "")}`}>{p.pair}</button>
                  <div className={cx("text-sm tabular", p.quote_stale ? "text-label-3" : "text-label-2")}>
                    {p.quote ? `${p.quote.bid.toFixed(digits)} / ${p.quote.ask.toFixed(digits)}` : "未取得"}
                    {p.quote && p.quote_stale && <span className="ml-1 text-xs">(古い)</span>}
                  </div>
                </div>
                <div className="space-y-2">
                  {p.rules.map((r) => (
                    <div key={r.rule} className="flex items-center justify-between gap-2" data-testid={`fx-mark-${p.pair.replace("/", "")}-${r.rule}`}>
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{RULES[r.rule]}</div>
                        <div className="text-xs text-label-3 tabular">{r.mark.bar_time ? `判定足 ${fmtDateTime(r.mark.bar_time)}` : "判定なし"}</div>
                      </div>
                      <MarkPill mark={r.mark} enabled={r.enabled} />
                    </div>
                  ))}
                </div>
              </div></Card>
            </Item>
          );
        })}
      </Stagger>
    </div>
  );
}

/* ------------------------------------------------------------- チャート */
const SPANS = [{ value: "6h", label: "6時間", sec: 6 * 3600 }, { value: "1d", label: "1日", sec: 86400 }, { value: "3d", label: "3日", sec: 3 * 86400 }] as const;
type Span = (typeof SPANS)[number]["value"];

function ChartTab() {
  const loc = useLocation(); const nav = useNavigate();
  const params = new URLSearchParams(loc.search);
  const pair = ((PAIRS as readonly string[]).includes(params.get("pair") ?? "") ? params.get("pair") : "USD/JPY") as Pair;
  const [rule, setRule] = useState<Rule>("rule_a");
  const [tf, setTf] = useState<Timeframe>("M5");
  const [span, setSpan] = useState<Span>("6h");
  const [to, setTo] = useState<number | null>(null); // null = now
  const [fitAll, setFitAll] = useState(false);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const spanSec = SPANS.find((s) => s.value === span)!.sec;
  const [tick, setTick] = useState(0);
  const toSec = to ?? Math.floor(Date.now() / 1000);
  const path = `/fx/chart?pair=${encodeURIComponent(pair)}&tf=${tf}&rule=${rule}&from=${toSec - spanSec}&to=${toSec}`;
  const { data, loading, error, reload } = useApi<ChartResponse>(path, { deps: [tick] });
  useEffect(() => { const id = setInterval(() => { if (document.visibilityState === "visible" && to == null) setTick((t) => t + 1); }, 30_000); return () => clearInterval(id); }, [to]);

  const shift = (dir: -1 | 1) => {
    const base = to ?? Math.floor(Date.now() / 1000);
    const next = base + dir * spanSec;
    const lo = data?.stored_range.from ?? null;
    if (dir === -1 && lo != null && next - spanSec < lo - spanSec) return; // stay inside stored range
    if (dir === 1 && next >= Math.floor(Date.now() / 1000)) { setTo(null); return; }
    setTo(next);
  };
  const toggles = useMemo(() => [
    ...(data?.lines.map((l) => ({ key: l.key, label: l.label })) ?? []),
    { key: "breakout", label: "突破水準" }, { key: "sl", label: "SL参考" }, { key: "pivot", label: "ピボット" }, { key: "markers", label: "約定・シグナル" },
  ], [data?.lines]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={pair} onChange={(e) => nav(`/fx/chart?pair=${encodeURIComponent(e.target.value)}`)} className="w-36" aria-label="通貨ペア" data-testid="fx-chart-pair">
          {PAIRS.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Segmented value={rule} onChange={setRule} options={RULE_KEYS.map((r) => ({ value: r, label: RULES[r] }))} />
        <Segmented value={span} onChange={(v) => { setSpan(v); }} options={SPANS.map((s) => ({ value: s.value, label: s.label }))} />
        <Segmented value={tf} onChange={setTf} options={(["M5", "H1", "H4", "D1"] as Timeframe[]).map((t) => ({ value: t, label: t }))} />
        <div className="flex-1" />
        <Button size="sm" onClick={() => shift(-1)} aria-label="前へ">‹ 前</Button>
        <Button size="sm" onClick={() => shift(1)} disabled={to == null} aria-label="次へ">次 ›</Button>
        <Button size="sm" variant={fitAll ? "tinted" : "secondary"} onClick={() => setFitAll((v) => !v)} data-testid="fx-fit-all">全水準表示</Button>
        <Button size="sm" variant="ghost" onClick={() => reload(true)} loading={loading && Boolean(data)}>更新</Button>
      </div>
      <Card padded={false} className="overflow-hidden">
        <div className="aspect-video w-full relative" data-testid="fx-chart">
          {data ? (
            <ChartView data={data} hidden={hidden} fitAll={fitAll} onReachStart={() => { if (data.stored_range.from != null && data.from > data.stored_range.from) shift(-1); }} onShiftWheel={(d) => shift(d)} />
          ) : error ? <EmptyState title="チャートを取得できません" hint={error} /> : <div className="absolute inset-0 skeleton" />}
        </div>
      </Card>
      {data && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {toggles.map((t) => (
              <button key={t.key} onClick={() => setHidden((h) => ({ ...h, [t.key]: !h[t.key] }))} className={cx("focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors", hidden[t.key] ? "bg-transparent text-label-3 line-through" : "bg-fill text-label")}>{t.label}</button>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-label-2 tabular">
            <span>表示 {fmtDateTime(new Date(data.from * 1000).toISOString())} – {fmtDateTime(new Date(data.to * 1000).toISOString())}（JST）</span>
            <span>保存範囲 {data.stored_range.from != null ? `${fmtDateTime(new Date(data.stored_range.from * 1000).toISOString())} – ${fmtDateTime(new Date((data.stored_range.to ?? 0) * 1000).toISOString())}` : "なし"}</span>
            <span>ATR14(H1) {data.stats.atr14_h1 != null ? data.stats.atr14_h1.toFixed(pipSize(pair) === 0.01 ? 3 : 5) : "—"}</span>
            <span>ADX14(H1) {data.stats.adx14_h1 != null ? data.stats.adx14_h1.toFixed(1) : "—"}{data.stats.adx_required != null && ` / 必要 ${data.stats.adx_required}`}</span>
            <span>約定マーカーは口座全体の取得履歴（選択ルール以外も含む）</span>
          </div>
          {(data.missing_ranges.length > 0 || data.insufficient.length > 0) && (
            <div className="text-xs text-orange space-y-0.5" data-testid="fx-chart-gaps">
              {data.candles.length === 0 && <div>この範囲の保存済みローソク足がありません。Windowsからの受信を待っています。</div>}
              {data.missing_ranges.length > 0 && data.candles.length > 0 && <div>欠損区間 {data.missing_ranges.length} 件（推測で埋めていません）</div>}
              {data.insufficient.length > 0 && <div>履歴不足で未表示: {data.insufficient.join("、")}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- 保有・履歴 */
type PositionsRes = { connector_online: boolean; last_seen: string | null; equity: number | null; account: string | null; connector_positions: ConnectorPosition[]; trades: TradeRow[] };
function PositionsTab() {
  const { data, loading } = useApi<PositionsRes>("/fx/positions", { poll: 5000 });
  if (loading && !data) return <PageSkeleton cards={3} />;
  if (!data) return <EmptyState title="取得できません" />;
  return (
    <div className="space-y-6">
      <Card className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="口座" value={data.account || "—"} />
        <Stat label="有効証拠金 (USD)" value={data.equity != null ? fmtNum(data.equity, 2) : "—"} hint={data.connector_online ? "受信中" : data.last_seen ? `最終受信 ${fmtDateTime(data.last_seen)} の値` : "未取得"} />
        <Stat label="端末の保有" value={data.connector_positions.length} />
        <Stat label="台帳の保有" value={data.trades.length} />
      </Card>
      <Section title="端末から受信した保有ポジション">
        {data.connector_positions.length === 0 ? <EmptyState title="保有なし" hint={data.connector_online ? undefined : "更新停止中の値は最終受信時点の記録です"} /> : (
          <Card padded={false}><TradeTable rows={data.connector_positions.map((p) => ({ id: p.ticket, rule: p.rule, pair: p.pair, side: p.side, ticket: p.ticket, open_at: p.open_at, close_at: null, open_price: p.open_price, close_price: null, lots: p.lots, sl: p.sl, tp: p.tp, pnl_usd: p.pnl_usd ?? null, r_multiple: null, status: "open" }))} /></Card>
        )}
      </Section>
      <Section title="台帳上の未決済取引（イベント受信ベース）">
        {data.trades.length === 0 ? <EmptyState title="なし" /> : <Card padded={false}><TradeTable rows={data.trades} /></Card>}
      </Section>
    </div>
  );
}

function TradeTable({ rows }: { rows: TradeRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="fx-trade-table">
        <thead className="text-xs text-label-2"><tr>{["ルール", "通貨", "方向", "数量", "建値", "決済", "SL", "TP", "損益 USD", "R", "開始", "終了"].map((h) => <th key={h} className="text-left font-medium px-4 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((t) => { const d = pipSize(t.pair) === 0.01 ? 3 : 5; const f = (v: number | null) => (v == null ? "—" : v.toFixed(d)); return (
            <tr key={t.id} className="border-t border-separator tabular">
              <td className="px-4 py-2 whitespace-nowrap">{RULES[t.rule] ?? t.rule}</td><td className="px-4 py-2">{t.pair}</td>
              <td className={cx("px-4 py-2 font-medium", t.side === "BUY" ? "text-accent" : "text-red")}>{t.side}</td>
              <td className="px-4 py-2">{t.lots ?? "—"}</td><td className="px-4 py-2">{f(t.open_price)}</td><td className="px-4 py-2">{f(t.close_price)}</td>
              <td className="px-4 py-2">{f(t.sl)}</td><td className="px-4 py-2">{f(t.tp)}</td>
              <td className={cx("px-4 py-2", t.pnl_usd != null && (t.pnl_usd >= 0 ? "text-green" : "text-red"))}>{t.pnl_usd != null ? fmtNum(t.pnl_usd, 2) : "—"}</td>
              <td className="px-4 py-2">{t.r_multiple != null ? t.r_multiple.toFixed(2) : "—"}</td>
              <td className="px-4 py-2 whitespace-nowrap">{fmtDateTime(t.open_at)}</td><td className="px-4 py-2 whitespace-nowrap">{fmtDateTime(t.close_at)}</td>
            </tr>
          ); })}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------- 履歴・成績 */
function TradesTab() {
  const [status, setStatus] = useState<"all" | "open" | "closed">("all");
  const trades = useApi<{ trades: TradeRow[] }>(`/fx/trades${status === "all" ? "" : `?status=${status}`}`, { poll: 30_000 });
  const perf = useApi<PerformanceResponse>("/fx/performance", { poll: 60_000 });
  if (!trades.data && trades.loading) return <PageSkeleton cards={3} />;
  return (
    <div className="space-y-6">
      <Section title="実取引の成績（現行3ルール）">
        <div className="text-xs text-label-3 px-1">{perf.data?.note}</div>
        <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
          {(perf.data?.by_rule ?? RULE_KEYS.map((rule) => ({ rule, trades: 0, wins: 0, r_total: 0, pnl_usd: 0 }))).map((r) => (
            <Card key={r.rule} className="space-y-2">
              <div className="font-semibold">{RULES[r.rule]}</div>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="確定件数" value={r.trades} />
                <Stat label="勝率" value={r.trades ? `${Math.round((r.wins / r.trades) * 100)}%` : "—"} />
                <Stat label="合計R" value={r.trades ? `${r.r_total >= 0 ? "+" : ""}${r.r_total.toFixed(2)}` : "—"} tone={r.trades ? (r.r_total >= 0 ? "green" : "red") : undefined} />
                <Stat label="損益 USD" value={r.trades ? fmtNum(r.pnl_usd, 2) : "—"} />
              </div>
            </Card>
          ))}
        </div>
        {perf.data && perf.data.by_month.length > 0 && (
          <Card padded={false}><div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="text-xs text-label-2"><tr>{["月", "ルール", "件数", "合計R", "損益 USD"].map((h) => <th key={h} className="text-left font-medium px-4 py-2">{h}</th>)}</tr></thead>
            <tbody>{perf.data.by_month.map((m) => <tr key={`${m.month}${m.rule}`} className="border-t border-separator tabular"><td className="px-4 py-2">{m.month}</td><td className="px-4 py-2">{RULES[m.rule]}</td><td className="px-4 py-2">{m.trades}</td><td className="px-4 py-2">{m.r_total.toFixed(2)}</td><td className="px-4 py-2">{fmtNum(m.pnl_usd, 2)}</td></tr>)}</tbody>
          </table></div></Card>
        )}
      </Section>
      <Section title="取引履歴" action={<Segmented value={status} onChange={setStatus} options={[{ value: "all", label: "すべて" }, { value: "open", label: "保有中" }, { value: "closed", label: "決済済み" }]} />}>
        {trades.data && trades.data.trades.length === 0 ? <EmptyState title="取引はまだありません" hint="Windowsコネクターから約定イベントを受信すると表示されます" /> : trades.data && <Card padded={false}><TradeTable rows={trades.data.trades} /></Card>}
      </Section>
    </div>
  );
}

/* ----------------------------------------------------------- 設定・接続 */
type InstallRes = { markdown: string; endpoints: Record<string, string>; downloads: { label: string; url: string | null; note: string }[]; token_configured: boolean };
function SettingsTab({ status, reloadStatus }: { status: StatusResponse | null; reloadStatus: () => void }) {
  const toast = useToast();
  const settings = useApi<FxSettings>("/fx/settings");
  const install = useApi<InstallRes>("/fx/install");
  const [form, setForm] = useState<FxSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (settings.data && !form) setForm(settings.data); }, [settings.data, form]);
  if (!form) return <PageSkeleton cards={2} />;
  const save = async () => {
    setSaving(true);
    try { const saved = await api.put<FxSettings>("/fx/settings", form); setForm(saved); settings.setData(saved); toast("保存しました。共通lotはWindowsの次回同期後の新規取引から反映されます", "success"); reloadStatus(); }
    catch (e: any) { toast(e?.message ?? "保存できません", "error"); } finally { setSaving(false); }
  };
  const num = (v: string, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <Section title="自動売買の許可">
          <Card className="space-y-4">
            {RULE_KEYS.map((r) => (
              <div key={r} className="flex items-center justify-between">
                <div><div className="font-medium">{RULES[r]}</div><div className="text-xs text-label-3">{r === "rule_a" ? "確定H1 · 共通lot · 追加最大3回 · SL倍率0.5" : r === "donchian4" ? "確定H4 · 共通lot · SL倍率1" : "確定H4 · 想定損失USDから数量計算 · R1/S1の外"}</div></div>
                <Toggle checked={form.rules[r].enabled} onChange={(v) => setForm({ ...form, rules: { ...form.rules, [r]: { enabled: v } } })} label={`${RULES[r]}を有効化`} />
              </div>
            ))}
            <div className="text-xs text-label-3">停止しても、端末が動いていれば既存の管理ポジションの保護と決済は続きます。</div>
          </Card>
        </Section>
        <Section title="数量と制限">
          <Card className="grid grid-cols-2 gap-4">
            <Field label="共通lot（A・改良4）" hint="次の新規取引から。保有中のAの追加は開始時のlotを維持"><Input type="number" step="0.01" min="0.01" value={form.common_lot} onChange={(e) => setForm({ ...form, common_lot: num(e.target.value, form.common_lot) })} data-testid="fx-common-lot" /></Field>
            <Field label="改良6の想定損失 (USD)" hint="SLまでの損失＋費用をこの額以内へ切り下げ"><Input type="number" step="1" min="1" value={form.risk_usd_donchian6} onChange={(e) => setForm({ ...form, risk_usd_donchian6: num(e.target.value, form.risk_usd_donchian6) })} /></Field>
            <Field label="取引時間 開始 (UTC時)"><Input type="number" min="0" max="23" value={form.trading_hours.start_utc} onChange={(e) => setForm({ ...form, trading_hours: { ...form.trading_hours, start_utc: num(e.target.value, 6) } })} /></Field>
            <Field label="取引時間 終了 (UTC時)"><Input type="number" min="1" max="24" value={form.trading_hours.end_utc} onChange={(e) => setForm({ ...form, trading_hours: { ...form.trading_hours, end_utc: num(e.target.value, 20) } })} /></Field>
            <div className="col-span-2 flex items-center justify-between"><span className="text-sm">平日のみ</span><Toggle checked={form.trading_hours.weekdays_only} onChange={(v) => setForm({ ...form, trading_hours: { ...form.trading_hours, weekdays_only: v } })} label="平日のみ" /></div>
            <Field label="日次 損失制限 (R)"><Input type="number" step="0.5" max="0" value={form.r_limits.day} onChange={(e) => setForm({ ...form, r_limits: { ...form.r_limits, day: num(e.target.value, -2) } })} /></Field>
            <Field label="週次 損失制限 (R)"><Input type="number" step="0.5" max="0" value={form.r_limits.week} onChange={(e) => setForm({ ...form, r_limits: { ...form.r_limits, week: num(e.target.value, -3) } })} /></Field>
            <Field label="月次 損失制限 (R)"><Input type="number" step="0.5" max="0" value={form.r_limits.month} onChange={(e) => setForm({ ...form, r_limits: { ...form.r_limits, month: num(e.target.value, -2) } })} /></Field>
            <Field label="自動停止理由（メモ）" className="col-span-2" hint="1行に1件。端末側の停止理由は接続状態に表示されます"><Input value={form.stop_reasons.join("\n")} onChange={(e) => setForm({ ...form, stop_reasons: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} /></Field>
            <div className="col-span-2 flex justify-end"><Button variant="primary" onClick={save} loading={saving} data-testid="fx-save-settings">保存</Button></div>
          </Card>
        </Section>
      </div>
      <div className="space-y-6">
        <Section title="接続状態">
          <Card className="space-y-3 text-sm">
            {status ? (
              <>
                <Row k="コネクター" v={status.connector_online ? <span className="text-green">接続中</span> : <span className="text-label-2">更新待ち</span>} />
                <Row k="最終受信" v={status.last_seen ? fmtDateTime(status.last_seen) : "なし"} />
                <Row k="バージョン" v={status.version ?? "—"} />
                <Row k="MT5" v={status.mt5_connected == null ? "—" : status.mt5_connected ? "ログイン済み" : "未接続"} />
                <Row k="実行リース (30秒)" v={status.lease.holder ? `${status.lease.holder} · ${fmtDateTime(status.lease.expires_at)}まで` : "なし"} />
                <Row k="損失制限" v={status.r_limit_block.blocked ? <span className="text-red">{status.r_limit_block.reason}</span> : `日 ${status.r_limit_block.day_r}R · 週 ${status.r_limit_block.week_r}R · 月 ${status.r_limit_block.month_r}R`} />
                <Row k="年度設定" v={status.year_config_valid ? `${status.year_config_valid_until} まで有効（改良4・6）` : <span className="text-orange">期限切れ · 新規停止中</span>} />
                <Row k="端末の停止理由" v={status.connector_stop_reasons.length ? status.connector_stop_reasons.join("、") : "なし"} />
                <Row k="接続トークン" v={status.token_configured ? "設定済み" : <span className="text-red">未設定（FX_CONNECTOR_TOKEN）</span>} />
              </>
            ) : "—"}
          </Card>
        </Section>
        <Section title="かんたん更新・インストール">
          <Card className="space-y-3">
            {install.data ? (
              <>
                <pre className="text-xs whitespace-pre-wrap leading-relaxed text-label-2 font-sans" data-testid="fx-install-md">{install.data.markdown}</pre>
                <div className="space-y-1 text-xs tabular">
                  {Object.entries(install.data.endpoints).map(([k, v]) => <div key={k} className="flex gap-2"><span className="text-label-3 w-20 shrink-0">{k}</span><code className="font-mono break-all">{v}</code></div>)}
                </div>
                <div className="flex flex-wrap gap-2">
                  {install.data.downloads.map((d) => <Button key={d.label} size="sm" disabled={!d.url} title={d.note}>{d.label}</Button>)}
                </div>
                <div className="text-xs text-label-3">{install.data.downloads.map((d) => d.note).join(" / ")}</div>
              </>
            ) : <div className="skeleton h-24" />}
          </Card>
        </Section>
      </div>
    </div>
  );
}
function Row({ k, v }: { k: string; v: ReactNode }) { return <div className="flex justify-between gap-4"><span className="text-label-2">{k}</span><span className="text-right tabular">{v}</span></div>; }

