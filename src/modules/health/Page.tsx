import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  PageHeader, PageSkeleton, Segmented, Card, Section, Stat, Badge, Button, IconButton, Input, Select, Textarea, Field, Modal,
  EmptyState, ErrorBanner, Stagger, Item, ChatPanel, ChartTip, Table, Th, Td, trCls, useChartColors, useToast, cx, type ChatMsg,
} from "@/components/ui";
import { api, useApi, fmtNum, fmtYen, fmtDate, fmtDateTime, todayJst } from "@/lib/api";
import type { PressureAssessment, PressureLevel } from "@shared/types";

/* ======================================================================
   Types (mirror of worker/modules/health)
   ====================================================================== */
type OuraRow = { day: string; sleep_duration_sec: number | null; sleep_score: number | null; readiness_score: number | null; steps: number | null; hrv: number | null; resting_hr: number | null; sleep_balance: number | null; synced_at?: string; is_today?: boolean };
type PressureLog = { id: string; logged_at: string; symptom: string | null; severity: number | null; pressure_hpa: number | null; delta3h: number | null; delta6h: number | null };
type Personal = { ready: false; count: number; reason: "insufficient" | "no_baseline" | "unclear" } | { ready: true; count: number; threshold: number; symptom_mean: number; baseline_mean: number };
type Overview = {
  today: string; oura: OuraRow | null; oura_configured: boolean; series: OuraRow[];
  weather: { location: { name: string }; pressure: PressureAssessment; fetched_at: string; series: { time: string; hpa: number | null }[] } | null;
  weather_configured: boolean; suggestion: string; pressure_logs: PressureLog[]; personal: Personal;
};
type Nutrition = Record<string, number>;
type Meal = { id: string; slot: Slot; food_name: string; amount: number | null; unit: string | null; nutrition: Nutrition | null; nutrition_source: "recorded" | "estimated" | null; cost_per_serving: number | null };
type MealsRes = { items: Meal[]; summary: { nutrition: { totals: Record<string, number | null>; partial: boolean; item_count: number; with_nutrition: number; estimated_count: number; partial_keys: string[] }; cost: { total: number | null; counted: number; missing: number }; targets: Nutrition } };
type Slot = "breakfast" | "lunch" | "dinner" | "snack";
type Beauty = { id: string; name: string; product: string | null; timing: string | null; purpose: string | null };
type Policy = { keep: string[]; add: string[]; review: string[]; note?: string; updated_at?: string } | null;
type Checkup = { id: string; checkup_date: string; notes: string | null } & Record<CheckupField, number | null>;
type ChatItem = ChatMsg & { id?: string; proposal?: any; applied?: Record<string, unknown> | null };

const SLOT_LABEL: Record<Slot, string> = { breakfast: "朝", lunch: "昼", dinner: "夜", snack: "間食" };
const SLOTS: Slot[] = ["breakfast", "lunch", "dinner", "snack"];
const MAIN_NUTRIENTS: { key: string; label: string; unit: string }[] = [
  { key: "energy_kcal", label: "エネルギー", unit: "kcal" }, { key: "protein_g", label: "たんぱく質", unit: "g" }, { key: "fat_g", label: "脂質", unit: "g" },
  { key: "carbs_g", label: "炭水化物", unit: "g" }, { key: "fiber_g", label: "食物繊維", unit: "g" }, { key: "salt_g", label: "食塩相当量", unit: "g" },
];
const EXTRA_NUTRIENTS: { key: string; label: string; unit: string }[] = [
  { key: "calcium_mg", label: "カルシウム", unit: "mg" }, { key: "iron_mg", label: "鉄", unit: "mg" }, { key: "magnesium_mg", label: "マグネシウム", unit: "mg" }, { key: "zinc_mg", label: "亜鉛", unit: "mg" }, { key: "potassium_mg", label: "カリウム", unit: "mg" },
  { key: "vitamin_a_ug", label: "ビタミンA", unit: "µg" }, { key: "vitamin_b1_mg", label: "ビタミンB1", unit: "mg" }, { key: "vitamin_b2_mg", label: "ビタミンB2", unit: "mg" }, { key: "vitamin_b6_mg", label: "ビタミンB6", unit: "mg" }, { key: "vitamin_b12_ug", label: "ビタミンB12", unit: "µg" },
  { key: "vitamin_c_mg", label: "ビタミンC", unit: "mg" }, { key: "vitamin_d_ug", label: "ビタミンD", unit: "µg" }, { key: "vitamin_e_mg", label: "ビタミンE", unit: "mg" }, { key: "folate_ug", label: "葉酸", unit: "µg" },
];
const CHECKUP_FIELDS = [
  { key: "ldl", label: "LDL", unit: "mg/dL" }, { key: "hdl", label: "HDL", unit: "mg/dL" }, { key: "tg", label: "中性脂肪", unit: "mg/dL" }, { key: "total_chol", label: "総コレステロール", unit: "mg/dL" },
  { key: "hba1c", label: "HbA1c", unit: "%" }, { key: "fasting_glucose", label: "空腹時血糖", unit: "mg/dL" }, { key: "bp_sys", label: "血圧（上）", unit: "mmHg" }, { key: "bp_dia", label: "血圧（下）", unit: "mmHg" },
  { key: "ggtp", label: "γ-GTP", unit: "U/L" }, { key: "ast", label: "AST", unit: "U/L" }, { key: "alt", label: "ALT", unit: "U/L" }, { key: "uric_acid", label: "尿酸", unit: "mg/dL" }, { key: "creatinine", label: "クレアチニン", unit: "mg/dL" },
] as const;
type CheckupField = (typeof CHECKUP_FIELDS)[number]["key"];

const fmtSleep = (sec: number | null | undefined) => { if (sec == null) return "—"; const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return `${h}:${String(m).padStart(2, "0")}`; };
const fmtDelta = (v: number | null | undefined) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)} hPa`);
const numOrNull = (s: string) => (s.trim() === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);
const LEVEL: Record<PressureLevel, { label: string; tone: "green" | "orange" | "red" | "neutral" }> = { stable: { label: "安定", tone: "green" }, caution: { label: "注意", tone: "orange" }, strong: { label: "強い変化", tone: "red" }, unknown: { label: "不明", tone: "neutral" } };

/* ======================================================================
   Chat hook (history + send; proposals from the last assistant message)
   ====================================================================== */
function useChat(channel: "health" | "meal" | "beauty") {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { let alive = true; api.get<{ items: ChatItem[] }>(`/health/chat/${channel}`).then((r) => alive && setMessages(r.items)).catch(() => {}); return () => { alive = false; }; }, [channel]);
  const send = useCallback(async (text: string) => {
    setMessages((m) => [...m, { role: "user", content: text }]); setBusy(true);
    try { const r = await api.post<{ reply: string; provider: string; proposal: any; id: string }>(`/health/chat/${channel}`, { message: text }); setMessages((m) => [...m, { id: r.id, role: "assistant", content: r.reply, provider: r.provider, proposal: r.proposal }]); }
    catch (e: any) { toast(e?.message ?? "送信に失敗しました", "error"); }
    finally { setBusy(false); }
  }, [channel, toast]);
  const lastProposal = useMemo(() => [...messages].reverse().find((m) => m.role === "assistant" && m.proposal)?.proposal ?? null, [messages]);
  const markApplied = useCallback((id: string, applied: Record<string, unknown>) => setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, applied } : m))), []);
  return { messages, busy, send, lastProposal, markApplied };
}

/* ======================================================================
   Page
   ====================================================================== */
type Tab = "condition" | "meal" | "beauty" | "checkup";
export default function Page() {
  const [tab, setTab] = useState<Tab>(() => (["condition", "meal", "beauty", "checkup"].includes(location.hash.slice(1)) ? (location.hash.slice(1) as Tab) : "condition"));
  const overview = useApi<Overview>("/health/overview", { poll: 10 * 60_000 });
  useEffect(() => { history.replaceState(null, "", `#${tab}`); }, [tab]);
  if (overview.loading && !overview.data) return <PageSkeleton />;
  return (
    <div>
      <PageHeader title="健康" subtitle={overview.data?.suggestion} />
      <Segmented<Tab> value={tab} onChange={setTab} className="mb-6" options={[{ value: "condition", label: "体調" }, { value: "meal", label: "食事" }, { value: "beauty", label: "美容" }, { value: "checkup", label: "検診" }]} />
      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
          {tab === "condition" && <ConditionTab data={overview.data} reload={() => overview.reload(true)} error={overview.error} />}
          {tab === "meal" && <MealTab />}
          {tab === "beauty" && <BeautyTab />}
          {tab === "checkup" && <CheckupTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* ======================================================================
   体調
   ====================================================================== */
function ConditionTab({ data, reload, error }: { data: Overview | null; reload: () => void; error: string | null }) {
  const toast = useToast();
  const chat = useChat("health");
  const [metric, setMetric] = useState<"sleep_score" | "readiness_score" | "steps" | "hrv">("sleep_score");
  const [syncing, setSyncing] = useState(false);
  const [logging, setLogging] = useState(false);
  const [editing, setEditing] = useState<PressureLog | null>(null);
  const cc = useChartColors();
  if (!data) return <div><ErrorBanner message={error} onRetry={reload} testId="health-error" /><EmptyState title="体調を読み込めませんでした" /></div>;
  const o = data.oura;
  const stale = o != null && !o.is_today;
  const sync = async () => {
    setSyncing(true);
    try { const r = await api.post<{ ok: boolean; synced?: number; skipped?: string; error?: string }>("/health/oura/sync"); if (r.skipped === "no_token") toast("Ouraのトークンが未設定です"); else if (r.ok) { toast(`${r.synced ?? 0}日分を同期しました`, "success"); reload(); } else toast(r.error ?? "同期に失敗しました", "error"); }
    catch (e: any) { toast(e?.message ?? "同期に失敗しました", "error"); } finally { setSyncing(false); }
  };
  const logNow = async () => {
    setLogging(true);
    try { const r = await api.post<{ item: PressureLog; weather_available: boolean }>("/health/pressure/logs", {}); toast(r.weather_available ? "記録しました" : "記録しました（気圧は未取得）", "success"); reload(); }
    catch (e: any) { toast(e?.message ?? "記録に失敗しました", "error"); } finally { setLogging(false); }
  };
  const del = async (l: PressureLog) => { if (!confirm(`${fmtDateTime(l.logged_at)} の記録を削除しますか？`)) return; try { await api.del(`/health/pressure/logs/${l.id}`); toast("削除しました"); reload(); } catch (e: any) { toast(e?.message ?? "削除できませんでした", "error"); } };
  const chartData = data.series.map((r) => ({ day: fmtDate(r.day), value: r[metric] }));
  const p = data.weather?.pressure ?? null;
  const personal = data.personal;
  return (
    <div className="grid gap-4 grid-cols-1 xl:grid-cols-3">
      {error && <div className="xl:col-span-3"><ErrorBanner message={error} onRetry={reload} className="mb-0" testId="health-error" /></div>}
      <div className="xl:col-span-2 space-y-4">
        <Card as="section" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2" data-testid="oura-card">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">Oura</h2>
              {o ? <Badge tone={stale ? "orange" : "green"}>記録日 {fmtDate(o.day)}{stale ? "（今日の値ではありません）" : "（今日）"}</Badge> : <Badge>未同期</Badge>}
            </div>
            <Button size="sm" onClick={sync} loading={syncing} data-testid="oura-sync">今すぐ同期</Button>
          </div>
          {!data.oura_configured && !o && <p className="text-sm text-label-2">Ouraのアクセストークンが未設定のため、同期できません。</p>}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-5">
            <Stat label="睡眠時間" value={fmtSleep(o?.sleep_duration_sec)} hint="時間:分" />
            <Stat label="睡眠スコア" value={fmtNum(o?.sleep_score)} />
            <Stat label="コンディション" value={fmtNum(o?.readiness_score)} />
            <Stat label="歩数" value={fmtNum(o?.steps)} />
            <Stat label="HRV" value={fmtNum(o?.hrv)} hint="ms" />
            <Stat label="安静時心拍" value={fmtNum(o?.resting_hr)} hint="bpm" />
            <Stat label="睡眠バランス" value={fmtNum(o?.sleep_balance)} hint="0〜100のスコア" />
          </div>
        </Card>

        <Card as="section" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold tracking-tight">14日間の推移</h2>
            <Segmented value={metric} onChange={setMetric} options={[{ value: "sleep_score", label: "睡眠" }, { value: "readiness_score", label: "回復" }, { value: "steps", label: "歩数" }, { value: "hrv", label: "HRV" }]} />
          </div>
          {chartData.length === 0 ? <div className="text-sm text-label-3 py-8 text-center">データがありません</div> : (
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <XAxis dataKey="day" tick={{ fontSize: cc.tickFont, fill: cc.label2 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis hide domain={["auto", "auto"]} />
                  <Tooltip cursor={{ stroke: cc.label3 }} content={({ active, payload }) => active && payload?.[0] ? <ChartTip label={(payload[0].payload as { day: string }).day} value={payload[0].value == null ? "—" : fmtNum(Number(payload[0].value))} /> : null} />
                  <Line type="monotone" dataKey="value" stroke={cc.accent} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card as="section" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2" data-testid="pressure-card">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">気圧</h2>
              {p ? <Badge tone={LEVEL[p.level].tone}>{LEVEL[p.level].label}</Badge> : <Badge>未取得</Badge>}
              {data.weather && <span className="text-xs text-label-3">{data.weather.location.name}・{fmtDateTime(data.weather.fetched_at)}</span>}
            </div>
            <Button variant="tinted" size="sm" onClick={logNow} loading={logging} data-testid="pressure-log-now">今しんどい</Button>
          </div>
          {!data.weather_configured && <p className="text-sm text-label-2">設定の「天気と体調」で位置を登録すると、気圧の変化を表示します。</p>}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat label="現在" value={p?.current != null ? `${fmtNum(p.current, 1)} hPa` : "—"} />
            <Stat label="3時間" value={fmtDelta(p?.delta3h)} tone={p && p.delta3h != null && Math.abs(p.delta3h) >= 2.5 ? (Math.abs(p.delta3h) >= 4 ? "red" : "orange") : undefined} />
            <Stat label="6時間" value={fmtDelta(p?.delta6h)} tone={p && p.delta6h != null && Math.abs(p.delta6h) >= 4 ? (Math.abs(p.delta6h) >= 6 ? "red" : "orange") : undefined} />
            <Stat label="12時間の幅" value={p?.range12h != null ? `${fmtNum(p.range12h, 1)} hPa` : "—"} />
          </div>
          {p?.missing && <p className="text-xs text-label-2">欠測があるため、安定とは断定していません。</p>}
          <div className="text-sm" data-testid="personal-status">
            {personal.ready
              ? <span>個人基準: 3時間で <span className="tabular font-semibold">{personal.threshold.toFixed(1)} hPa</span> 以上の変化で注意（記録 {personal.count}件）。因果の証明ではなく目安です。</span>
              : <span className="text-label-2">{personal.reason === "insufficient" ? `個人基準は未作成（有効な記録 ${personal.count}/5件）` : personal.reason === "no_baseline" ? `個人基準は未作成（比較用の気圧履歴が不足、記録 ${personal.count}件）` : `個人基準は未作成（記録 ${personal.count}件、気圧変化との関連がまだ明確ではありません）`}</span>}
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-label-2">記録</div>
            {data.pressure_logs.length === 0 ? <div className="text-sm text-label-3 py-3">記録はありません</div> : (
              <Stagger className="divide-y divide-separator">
                {data.pressure_logs.map((l) => (
                  <Item key={l.id} className="flex items-center gap-3 py-2">
                    <div className="flex-1 min-w-0" data-testid="pressure-log-item">
                      <div className="text-sm">{fmtDateTime(l.logged_at)} <span className="text-label-2">{l.symptom ?? "症状未入力"}{l.severity != null ? `・強さ${l.severity}` : ""}</span></div>
                      <div className="text-xs text-label-3 tabular">{l.pressure_hpa != null ? `${fmtNum(l.pressure_hpa, 1)} hPa` : "気圧 —"}・3h {fmtDelta(l.delta3h)}・6h {fmtDelta(l.delta6h)}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(l)} aria-label={`${fmtDateTime(l.logged_at)} の記録を編集`}>編集</Button>
                    <IconButton label={`${fmtDateTime(l.logged_at)} の記録を削除`} className="text-red hover:text-red" onClick={() => del(l)}>✕</IconButton>
                  </Item>
                ))}
              </Stagger>
            )}
          </div>
        </Card>
      </div>
      <Card as="section" className="xl:col-span-1 flex flex-col">
        <h2 className="text-lg font-semibold tracking-tight mb-2">健康チャット</h2>
        <ChatPanel messages={chat.messages} onSend={chat.send} busy={chat.busy} placeholder="今日の過ごし方を相談…" emptyHint="睡眠・回復・歩数・筋トレ・気圧をもとに答えます。診断はしません。" />
      </Card>
      <PressureLogModal log={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
    </div>
  );
}

function PressureLogModal({ log, onClose, onSaved }: { log: PressureLog | null; onClose: () => void; onSaved: () => void }) {
  const [symptom, setSymptom] = useState(""); const [severity, setSeverity] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setSymptom(log?.symptom ?? ""); setSeverity(log?.severity != null ? String(log.severity) : ""); }, [log]);
  const toast = useToast();
  const save = async () => { if (!log) return; setSaving(true); try { await api.patch(`/health/pressure/logs/${log.id}`, { symptom: symptom.trim() || null, severity: numOrNull(severity) }); onSaved(); } catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setSaving(false); } };
  return (
    <Modal open={Boolean(log)} onClose={onClose} title="記録を編集" footer={<><Button onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={save} loading={saving} data-testid="pressure-log-save">保存</Button></>}>
      <div className="space-y-3">
        <Field label="症状"><Input value={symptom} onChange={(e) => setSymptom(e.target.value)} placeholder="頭痛、だるさ など" data-testid="pressure-log-symptom" /></Field>
        <Field label="強さ（1〜5）"><Select value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="">未入力</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
      </div>
    </Modal>
  );
}

/* ======================================================================
   食事
   ====================================================================== */
/* ---------- Meal chat proposal: review and apply routine changes / target changes ---------- */
type MealOp =
  | { op: "add"; slot: Slot; food_name: string; amount: number | null; unit: string | null; cost_per_serving: number | null; nutrition: Nutrition | null }
  | { op: "update"; id: string; food_name: string; changes: Partial<{ slot: Slot; food_name: string; amount: number | null; unit: string | null; cost_per_serving: number | null; nutrition: Nutrition | null }> }
  | { op: "remove"; id: string; food_name: string };
const ALL_NUTRIENTS = [...MAIN_NUTRIENTS, ...EXTRA_NUTRIENTS];
const nutrientLabel = (k: string) => ALL_NUTRIENTS.find((n) => n.key === k) ?? { key: k, label: k, unit: "" };
const amountText = (a: number | null | undefined, u: string | null | undefined) => (a == null ? "量未設定" : `${fmtNum(a, 1)}${u ?? ""}`);
const kcalText = (n: Nutrition | null | undefined) => (n?.energy_kcal != null ? `約${fmtNum(n.energy_kcal)}kcal` : null);

function MealProposalCard({ item, meals, targets, onApplied, onEstimates, applyingEstimates }: {
  item: ChatItem; meals: Meal[]; targets: Nutrition; onApplied: (r: Record<string, unknown>) => void;
  onEstimates: (e: { food_name: string; nutrition: Nutrition }[]) => void; applyingEstimates: boolean;
}) {
  const toast = useToast();
  const p = item.proposal as { routines?: MealOp[]; targets?: Nutrition | null; estimates?: { food_name: string; nutrition: Nutrition }[]; error?: string };
  const ops = p.routines ?? [];
  const targetRows = Object.entries(p.targets ?? {}).filter(([k, v]) => targets[k] !== v);
  const [sel, setSel] = useState<Set<number>>(() => new Set(ops.map((_, i) => i)));
  const [useTargets, setUseTargets] = useState(targetRows.length > 0);
  const [busy, setBusy] = useState(false);
  const applied = item.applied;
  const count = sel.size + (useTargets ? 1 : 0);
  const describe = (op: MealOp) => {
    if (op.op === "add") return { tag: "追加", tone: "green" as const, text: `${SLOT_LABEL[op.slot]}・${op.food_name} ${amountText(op.amount, op.unit)}`, sub: [kcalText(op.nutrition), op.nutrition ? "栄養は推定" : "栄養未計算", op.cost_per_serving != null ? fmtYen(op.cost_per_serving) : null].filter(Boolean).join("・") };
    if (op.op === "remove") { const cur = meals.find((m) => m.id === op.id); return { tag: "削除", tone: "red" as const, text: `${cur ? SLOT_LABEL[cur.slot] + "・" : ""}${op.food_name}`, sub: cur ? amountText(cur.amount, cur.unit) : "" }; }
    const cur = meals.find((m) => m.id === op.id); const ch = op.changes; const parts: string[] = [];
    if (ch.slot) parts.push(`${cur ? SLOT_LABEL[cur.slot] : "?"} → ${SLOT_LABEL[ch.slot]}`);
    if (ch.food_name) parts.push(`名前 → ${ch.food_name}`);
    if (ch.amount !== undefined) parts.push(`${amountText(cur?.amount, cur?.unit)} → ${amountText(ch.amount, ch.unit ?? cur?.unit)}`);
    if (ch.cost_per_serving !== undefined) parts.push(`費用 → ${ch.cost_per_serving == null ? "未入力" : fmtYen(ch.cost_per_serving)}`);
    if (ch.nutrition) parts.push(`栄養 → ${kcalText(ch.nutrition) ?? "更新"}（推定）`);
    else if (ch.amount != null && cur?.nutrition) parts.push("栄養は量に合わせて換算（推定）");
    return { tag: "変更", tone: "accent" as const, text: `${cur ? SLOT_LABEL[cur.slot] + "・" : ""}${op.food_name}`, sub: parts.join("、") };
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ added: number; updated: number; removed: number; targets: boolean; skipped: number }>("/health/meals/apply-proposal", {
        message_id: item.id, routines: ops.filter((_, i) => sel.has(i)), targets: useTargets ? Object.fromEntries(targetRows) : null,
      });
      const msg = [r.added && `追加${r.added}件`, r.updated && `変更${r.updated}件`, r.removed && `削除${r.removed}件`, r.targets && "目標を更新"].filter(Boolean).join("・");
      toast(msg ? `反映しました（${msg}）` : "反映できる変更がありませんでした", msg ? "success" : "neutral");
      if (r.skipped) toast(`${r.skipped}件は現在のルーティンと合わないため反映しませんでした`);
      onApplied({ ...r, at: new Date().toISOString() });
    } catch (e: any) { toast(e?.message ?? "反映に失敗しました", "error"); } finally { setBusy(false); }
  };
  if (p.error) return <div className="mt-2 rounded-[var(--radius-lg)] bg-orange/10 p-3 text-sm text-label-2" data-testid="meal-proposal-error">{p.error}</div>;
  return (
    <div className="mt-2 rounded-[var(--radius-lg)] bg-subtle p-3 space-y-2 text-sm" data-testid="meal-proposal">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">提案された変更</span>
        {applied ? <Badge tone="green"><span data-testid="meal-proposal-applied">反映済み</span></Badge> : null}
      </div>
      {ops.length > 0 && (
        <ul className="space-y-1.5" data-testid="meal-proposal-ops">
          {ops.map((op, i) => { const d = describe(op); return (
            <li key={i}>
              <label className={cx("flex items-start gap-2", applied && "opacity-60")}>
                <input type="checkbox" className="mt-1 accent-[var(--accent)] size-4 shrink-0" checked={sel.has(i)} disabled={!!applied || busy}
                  onChange={(e) => setSel((s0) => { const n = new Set(s0); e.target.checked ? n.add(i) : n.delete(i); return n; })} aria-label={`${d.tag} ${d.text}`} />
                <span className="min-w-0"><Badge tone={d.tone} className="mr-1.5">{d.tag}</Badge><span>{d.text}</span>{d.sub && <span className="block text-xs text-label-2 mt-0.5">{d.sub}</span>}</span>
              </label>
            </li>
          ); })}
        </ul>
      )}
      {targetRows.length > 0 && (
        <div className={cx("space-y-1", applied && "opacity-60")}>
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--accent)] size-4" checked={useTargets} disabled={!!applied || busy} onChange={(e) => setUseTargets(e.target.checked)} aria-label="目標値を変更する" /><Badge tone="purple">目標</Badge><span>1日の目標値を変更</span></label>
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 gap-y-0.5 pl-6 text-xs tabular" data-testid="meal-proposal-targets">
            {targetRows.map(([k, v]) => { const n = nutrientLabel(k); return (
              <div key={k} className="contents"><span className="text-label-2">{n.label}</span><span className="text-right text-label-3">{targets[k] != null ? fmtNum(targets[k], 1) : "未設定"}</span><span className="text-label-3">→</span><span className="text-right font-medium">{fmtNum(v, 1)}{n.unit}</span></div>
            ); })}
          </div>
        </div>
      )}
      {!applied && (ops.length > 0 || targetRows.length > 0) && (
        <Button size="sm" variant="primary" className="w-full" loading={busy} disabled={count === 0} onClick={apply} data-testid="meal-proposal-apply">選んだ変更を反映（{count}件）</Button>
      )}
      {p.estimates && p.estimates.length > 0 && (
        <Button size="sm" variant="tinted" className="w-full" loading={applyingEstimates} onClick={() => onEstimates(p.estimates!)} data-testid="apply-estimates">栄養の推定値を反映（{p.estimates.length}件）</Button>
      )}
    </div>
  );
}

function MealTab() {
  const toast = useToast();
  const meals = useApi<MealsRes>("/health/meals");
  const chat = useChat("meal");
  const [editing, setEditing] = useState<Meal | "new" | null>(null);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [estimating, setEstimating] = useState<string | null>(null);
  const [showExtra, setShowExtra] = useState(false);
  const [applying, setApplying] = useState(false);
  const reload = () => meals.reload(true);
  if (meals.loading && !meals.data) return <PageSkeleton cards={3} />;
  const d = meals.data; if (!d) return <div><ErrorBanner message={meals.error} onRetry={() => meals.reload()} testId="health-error" /><EmptyState title="食事を読み込めませんでした" /></div>;
  const { totals, partial, item_count, with_nutrition, estimated_count } = d.summary.nutrition;
  const cost = d.summary.cost; const targets = d.summary.targets;

  const estimate = async (m: Meal) => {
    setEstimating(m.id);
    try {
      let r = await api.post<{ applied: boolean; reason?: string; estimate: Nutrition | null }>(`/health/meals/${m.id}/estimate`, {});
      if (!r.applied && r.reason === "recorded") {
        if (!confirm(`「${m.food_name}」には記録済みの栄養値があります。推定値で上書きしますか？`)) return;
        r = await api.post(`/health/meals/${m.id}/estimate`, { confirm: true });
      }
      if (r.applied) { toast("推定値を保存しました", "success"); reload(); }
      else if (r.reason === "ai_unavailable") toast("AIに接続できないため推定できません", "error");
    } catch (e: any) { toast(e?.message ?? "推定に失敗しました", "error"); } finally { setEstimating(null); }
  };
  const del = async (m: Meal) => { if (!confirm(`「${m.food_name}」を削除しますか？`)) return; try { await api.del(`/health/meals/${m.id}`); toast("削除しました"); reload(); } catch (e: any) { toast(e?.message ?? "削除できませんでした", "error"); } };
  const applyTargets = async (t: Nutrition) => { setApplying(true); try { await api.put("/health/targets", t); toast("目標を保存しました", "success"); reload(); } catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setApplying(false); } };
  const applyEstimates = async (ests: { food_name: string; nutrition: Nutrition }[]) => {
    setApplying(true);
    try {
    let n = 0;
    for (const e of ests) {
      const m = d.items.find((x) => x.food_name === e.food_name); if (!m) continue;
      let r = await api.post<{ applied: boolean; reason?: string }>(`/health/meals/${m.id}/apply-estimate`, { nutrition: e.nutrition });
      if (!r.applied && r.reason === "recorded" && confirm(`「${m.food_name}」の記録済みの値を推定値で上書きしますか？`)) r = await api.post(`/health/meals/${m.id}/apply-estimate`, { nutrition: e.nutrition, confirm: true });
      if (r.applied) n++;
    }
    toast(n ? `${n}件に反映しました` : "反映できる項目がありませんでした", n ? "success" : "neutral"); reload();
    } catch (e: any) { toast(e?.message ?? "反映に失敗しました", "error"); } finally { setApplying(false); }
  };

  return (
    <div className="grid gap-4 grid-cols-1 xl:grid-cols-3">
      <div className="xl:col-span-2 space-y-4">
        <Card as="section" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">1日分の栄養</h2>
              {item_count > 0 && (partial ? <Badge tone="orange"><span data-testid="nutrition-partial">途中の値（{with_nutrition}/{item_count}件が計算済み）</span></Badge> : <Badge tone="green"><span data-testid="nutrition-complete">全件計算済み</span></Badge>)}
              {estimated_count > 0 && <Badge>推定を含む {estimated_count}件</Badge>}
            </div>
            <Button size="sm" onClick={() => setTargetsOpen(true)} data-testid="targets-edit">目標を編集</Button>
          </div>
          {item_count === 0 ? <p className="text-sm text-label-3">ルーティンを登録すると集計します。</p> : (
            <div className="space-y-2">
              {(showExtra ? [...MAIN_NUTRIENTS, ...EXTRA_NUTRIENTS] : MAIN_NUTRIENTS).map((n) => <NutrientBar key={n.key} label={n.label} unit={n.unit} value={totals[n.key] ?? null} target={targets[n.key] ?? null} partial={partial} />)}
              <Button size="sm" variant="ghost" aria-expanded={showExtra} onClick={() => setShowExtra((v) => !v)}>{showExtra ? "主要項目だけ表示" : "ミネラル・ビタミンも表示"}</Button>
              {partial && <p className="text-xs text-label-2">栄養が未計算の食品があるため、合計は途中の値です。不足・過剰は断定しません。</p>}
            </div>
          )}
          <div className="flex items-baseline gap-2 pt-1">
            <span className="text-xs text-label-2 font-medium">1日の食費（概算）</span>
            <span className="text-lg font-semibold tabular" data-testid="meal-cost-total">{cost.total == null ? "未入力" : fmtYen(cost.total)}</span>
            {cost.missing > 0 && <span className="text-xs text-label-3">費用未入力 {cost.missing}件（無料とは扱いません）</span>}
          </div>
        </Card>

        <Section title="ルーティン" action={<Button variant="primary" size="sm" onClick={() => setEditing("new")} data-testid="meal-add">追加</Button>}>
          {d.items.length === 0 ? <Card><EmptyState title="ルーティンがありません" hint="普段食べるものを登録すると、1日分の栄養と食費を集計します。" /></Card> : (
            <div className="space-y-3">
              {SLOTS.map((slot) => { const list = d.items.filter((m) => m.slot === slot); if (!list.length) return null; return (
                <Card key={slot} padded={false} className="px-5 py-3">
                  <div className="text-xs font-medium text-label-2 mb-1">{SLOT_LABEL[slot]}</div>
                  <Stagger className="divide-y divide-separator">
                    {list.map((m) => (
                      <Item key={m.id} className="flex items-center gap-3 py-2.5">
                        <div className="flex-1 min-w-0" data-testid="meal-item">
                          <div className="flex items-center gap-2 flex-wrap"><span className="font-medium truncate">{m.food_name}</span>
                            {m.amount != null && <span className="text-sm text-label-2 tabular">{fmtNum(m.amount, 1)}{m.unit ?? ""}</span>}
                            {m.nutrition_source === "recorded" ? <Badge tone="green">記録</Badge> : m.nutrition_source === "estimated" ? <Badge tone="accent">推定</Badge> : <Badge>栄養未計算</Badge>}
                          </div>
                          <div className="text-xs text-label-3 tabular">{m.nutrition ? `${fmtNum(m.nutrition.energy_kcal)} kcal・P ${fmtNum(m.nutrition.protein_g)}・F ${fmtNum(m.nutrition.fat_g)}・C ${fmtNum(m.nutrition.carbs_g)}` : "—"}・{m.cost_per_serving == null ? "費用未入力" : fmtYen(m.cost_per_serving)}</div>
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => estimate(m)} loading={estimating === m.id} aria-label={`${m.food_name}の栄養をAIで推定`} data-testid="meal-estimate">AI推定</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(m)} aria-label={`${m.food_name}を編集`}>編集</Button>
                        <IconButton label={`${m.food_name}を削除`} className="text-red hover:text-red" onClick={() => del(m)}>✕</IconButton>
                      </Item>
                    ))}
                  </Stagger>
                </Card>
              ); })}
            </div>
          )}
        </Section>
      </div>
      <Card as="section" className="xl:col-span-1 flex flex-col xl:sticky xl:top-20 self-start w-full">
        <h2 className="text-lg font-semibold tracking-tight mb-2">食事チャット</h2>
        <ChatPanel messages={chat.messages} onSend={chat.send} busy={chat.busy} placeholder="例: 朝にヨーグルト200gを追加して / たんぱく質の目標を120gに"
          emptyHint="ルーティンと目標をもとに相談できます。追加・変更・削除や目標の変更を頼むと、反映できる提案が出ます。"
          renderExtra={(m) => {
            const it = m as ChatItem;
            return it.proposal && (it.proposal.error || it.proposal.routines?.length || it.proposal.targets || it.proposal.estimates?.length)
              ? <MealProposalCard item={it} meals={d.items} targets={targets} onApplied={(res) => { chat.markApplied(it.id!, res); reload(); }} onEstimates={applyEstimates} applyingEstimates={applying} />
              : null;
          }} />
      </Card>
      <MealModal meal={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      <TargetsModal open={targetsOpen} targets={targets} onClose={() => setTargetsOpen(false)} onSaved={() => { setTargetsOpen(false); reload(); }} />
    </div>
  );
}

function NutrientBar({ label, unit, value, target, partial }: { label: string; unit: string; value: number | null; target: number | null; partial: boolean }) {
  const ratio = value != null && target ? Math.min(1, value / target) : 0;
  return (
    <div className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm">
      <span className="text-label-2">{label}</span>
      <div className="h-1.5 rounded-full bg-fill overflow-hidden"><motion.div className={cx("h-full rounded-full", partial ? "bg-label-3" : "bg-accent")} initial={{ width: 0 }} animate={{ width: `${ratio * 100}%` }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} /></div>
      <span className="tabular text-right whitespace-nowrap">{value == null ? "—" : fmtNum(value, unit === "g" || unit === "mg" ? 1 : 0)}{target != null ? <span className="text-label-3"> / {fmtNum(target, 0)}</span> : null} <span className="text-label-3 text-xs">{unit}</span></span>
    </div>
  );
}

function MealModal({ meal, onClose, onSaved }: { meal: Meal | "new" | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ slot: "breakfast" as Slot, food_name: "", amount: "", unit: "", cost: "" });
  const [n, setN] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (meal && meal !== "new") { setF({ slot: meal.slot, food_name: meal.food_name, amount: meal.amount != null ? String(meal.amount) : "", unit: meal.unit ?? "", cost: meal.cost_per_serving != null ? String(meal.cost_per_serving) : "" }); setN(Object.fromEntries(Object.entries(meal.nutrition ?? {}).map(([k, v]) => [k, String(v)]))); }
    else { setF({ slot: "breakfast", food_name: "", amount: "", unit: "", cost: "" }); setN({}); }
  }, [meal]);
  const save = async () => {
    if (!f.food_name.trim()) return;
    const nutrition: Nutrition = {}; for (const [k, v] of Object.entries(n)) { const x = numOrNull(v); if (x != null) nutrition[k] = x; }
    const body: any = { slot: f.slot, food_name: f.food_name.trim(), amount: numOrNull(f.amount), unit: f.unit.trim() || null, cost_per_serving: numOrNull(f.cost) };
    const isEdit = meal && meal !== "new";
    const touchedNutrition = Object.keys(nutrition).length > 0 || (isEdit && meal.nutrition && Object.keys(nutrition).length === 0 && meal.nutrition_source === "recorded");
    if (!isEdit ? Object.keys(nutrition).length > 0 : touchedNutrition && JSON.stringify(nutrition) !== JSON.stringify(meal.nutrition ?? {})) body.nutrition = Object.keys(nutrition).length ? nutrition : null;
    setSaving(true);
    try { if (isEdit) await api.put(`/health/meals/${meal.id}`, body); else await api.post("/health/meals", body); toast("保存しました", "success"); onSaved(); }
    catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setSaving(false); }
  };
  return (
    <Modal open={Boolean(meal)} onClose={onClose} title={meal === "new" ? "ルーティンを追加" : "ルーティンを編集"} footer={<><Button onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={save} loading={saving} disabled={!f.food_name.trim()} data-testid="meal-save">保存</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="タイミング"><Select value={f.slot} onChange={(e) => setF({ ...f, slot: e.target.value as Slot })} data-testid="meal-slot">{SLOTS.map((s) => <option key={s} value={s}>{SLOT_LABEL[s]}</option>)}</Select></Field>
          <Field label="1回分の費用（円）" hint="未入力は無料とは扱いません"><Input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} placeholder="未入力" data-testid="meal-cost" /></Field>
        </div>
        <Field label="食品"><Input value={f.food_name} onChange={(e) => setF({ ...f, food_name: e.target.value })} placeholder="例: 鶏むね肉のサラダ" data-testid="meal-name" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="量"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="150" /></Field>
          <Field label="単位"><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="g / 個 / 杯" /></Field>
        </div>
        <details className="rounded-[var(--radius-md)] bg-subtle p-3">
          <summary className="text-sm font-medium cursor-pointer">栄養を手入力（記録値）</summary>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
            {[...MAIN_NUTRIENTS, ...EXTRA_NUTRIENTS].map((x) => <Field key={x.key} label={`${x.label} (${x.unit})`}><Input inputMode="decimal" value={n[x.key] ?? ""} onChange={(e) => setN({ ...n, [x.key]: e.target.value })} /></Field>)}
          </div>
          <p className="text-xs text-label-3 mt-2">空欄のままなら「AI推定」で埋められます。手入力した値は記録値として扱い、確認なしに上書きしません。</p>
        </details>
      </div>
    </Modal>
  );
}

function TargetsModal({ open, targets, onClose, onSaved }: { open: boolean; targets: Nutrition; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [t, setT] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setT(Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, String(v)]))); }, [open, targets]);
  const save = async () => {
    const out: Nutrition = {}; for (const [k, v] of Object.entries(t)) { const x = numOrNull(v); if (x != null) out[k] = x; }
    setSaving(true); try { await api.put("/health/targets", out); toast("目標を保存しました", "success"); onSaved(); } catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setSaving(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="1日の栄養目標" footer={<><Button onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={save} loading={saving} data-testid="targets-save">保存</Button></>}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {[...MAIN_NUTRIENTS, ...EXTRA_NUTRIENTS].map((x) => <Field key={x.key} label={`${x.label} (${x.unit})`}><Input inputMode="decimal" value={t[x.key] ?? ""} onChange={(e) => setT({ ...t, [x.key]: e.target.value })} placeholder="未設定" /></Field>)}
      </div>
    </Modal>
  );
}

/* ======================================================================
   美容
   ====================================================================== */
function BeautyTab() {
  const toast = useToast();
  const data = useApi<{ items: Beauty[]; policy: Policy }>("/health/beauty");
  const chat = useChat("beauty");
  const [editing, setEditing] = useState<Beauty | "new" | null>(null);
  const [applying, setApplying] = useState(false);
  const reload = () => data.reload(true);
  if (data.loading && !data.data) return <PageSkeleton cards={3} />;
  const d = data.data; if (!d) return <div><ErrorBanner message={data.error} onRetry={() => data.reload()} testId="health-error" /><EmptyState title="美容を読み込めませんでした" /></div>;
  const prop = chat.lastProposal as { keep: string[]; add: string[]; review: string[] } | null;
  const applyPolicy = async (p: { keep: string[]; add: string[]; review: string[] }) => { setApplying(true); try { await api.put("/health/beauty/policy", p); toast("方針を保存しました", "success"); reload(); } catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setApplying(false); } };
  const del = async (b: Beauty) => { if (!confirm(`「${b.name}」を削除しますか？`)) return; try { await api.del(`/health/beauty/${b.id}`); toast("削除しました"); reload(); } catch (e: any) { toast(e?.message ?? "削除できませんでした", "error"); } };
  const PolicyList = ({ title, items, tone }: { title: string; items: string[]; tone: "green" | "accent" | "orange" }) => (
    <div><div className="flex items-center gap-2 mb-1"><Badge tone={tone}>{title}</Badge></div>{items.length ? <ul className="text-sm space-y-0.5">{items.map((s, i) => <li key={i}>・{s}</li>)}</ul> : <div className="text-sm text-label-3">なし</div>}</div>
  );
  return (
    <div className="grid gap-4 grid-cols-1 xl:grid-cols-3">
      <div className="xl:col-span-2 space-y-4">
        <Section title="ルーティン" action={<Button variant="primary" size="sm" onClick={() => setEditing("new")} data-testid="beauty-add">追加</Button>}>
          {d.items.length === 0 ? <Card><EmptyState title="ルーティンがありません" hint="普段のケア、使うもの、タイミング、目的を登録します。" /></Card> : (
            <Card padded={false} className="px-5 py-2">
              <Stagger className="divide-y divide-separator">
                {d.items.map((b) => (
                  <Item key={b.id} className="flex items-center gap-3 py-3">
                    <div className="flex-1 min-w-0" data-testid="beauty-item">
                      <div className="flex items-center gap-2 flex-wrap"><span className="font-medium">{b.name}</span>{b.timing && <Badge>{b.timing}</Badge>}</div>
                      <div className="text-xs text-label-2">{[b.product, b.purpose].filter(Boolean).join("・") || "—"}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(b)} aria-label={`${b.name}を編集`}>編集</Button>
                    <IconButton label={`${b.name}を削除`} className="text-red hover:text-red" onClick={() => del(b)}>✕</IconButton>
                  </Item>
                ))}
              </Stagger>
            </Card>
          )}
        </Section>
        <Card as="section" className="space-y-3">
          <div className="flex items-center justify-between" data-testid="beauty-policy"><h2 className="text-lg font-semibold tracking-tight">方針</h2>{d.policy?.updated_at && <span className="text-xs text-label-3">{fmtDate(d.policy.updated_at)} 更新</span>}</div>
          {d.policy ? <div className="grid sm:grid-cols-3 gap-4"><PolicyList title="続けること" items={d.policy.keep} tone="green" /><PolicyList title="追加候補" items={d.policy.add} tone="accent" /><PolicyList title="見直すこと" items={d.policy.review} tone="orange" /></div>
            : <p className="text-sm text-label-3">美容チャットの提案を「この方針を使う」で保存すると、ここに表示されます。</p>}
        </Card>
      </div>
      <Card as="section" className="xl:col-span-1 flex flex-col">
        <h2 className="text-lg font-semibold tracking-tight mb-2">美容チャット</h2>
        <ChatPanel messages={chat.messages} onSend={chat.send} busy={chat.busy} placeholder="ケアの見直しを相談…" emptyHint="睡眠・食事・活動・検診も参照して、続けること・追加候補・見直すことを提案します。"
          actions={prop ? <Button size="sm" variant="tinted" loading={applying} onClick={() => applyPolicy(prop)} data-testid="apply-policy">この方針を使う</Button> : undefined} />
      </Card>
      <BeautyModal item={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
    </div>
  );
}

function BeautyModal({ item, onClose, onSaved }: { item: Beauty | "new" | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: "", product: "", timing: "", purpose: "" });
  const [saving, setSaving] = useState(false);
  useEffect(() => { setF(item && item !== "new" ? { name: item.name, product: item.product ?? "", timing: item.timing ?? "", purpose: item.purpose ?? "" } : { name: "", product: "", timing: "", purpose: "" }); }, [item]);
  const save = async () => {
    const body = { name: f.name.trim(), product: f.product.trim() || null, timing: f.timing.trim() || null, purpose: f.purpose.trim() || null };
    setSaving(true);
    try { if (item && item !== "new") await api.put(`/health/beauty/${item.id}`, body); else await api.post("/health/beauty", body); toast("保存しました", "success"); onSaved(); }
    catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setSaving(false); }
  };
  return (
    <Modal open={Boolean(item)} onClose={onClose} title={item === "new" ? "ルーティンを追加" : "ルーティンを編集"} footer={<><Button onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={save} loading={saving} disabled={!f.name.trim()} data-testid="beauty-save">保存</Button></>}>
      <div className="space-y-3">
        <Field label="ケア"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="例: 保湿" data-testid="beauty-name" /></Field>
        <Field label="使うもの"><Input value={f.product} onChange={(e) => setF({ ...f, product: e.target.value })} placeholder="製品名など" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="タイミング"><Input value={f.timing} onChange={(e) => setF({ ...f, timing: e.target.value })} placeholder="朝 / 夜 / 入浴後" /></Field>
          <Field label="目的"><Input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} placeholder="乾燥対策 など" /></Field>
        </div>
      </div>
    </Modal>
  );
}

/* ======================================================================
   検診
   ====================================================================== */
function CheckupTab() {
  const toast = useToast();
  const data = useApi<{ items: Checkup[] }>("/health/checkups");
  const [f, setF] = useState<Record<string, string>>({ checkup_date: todayJst() });
  const [saving, setSaving] = useState(false);
  const reload = () => data.reload(true);
  if (data.loading && !data.data) return <PageSkeleton cards={2} />;
  if (!data.data) return <div><ErrorBanner message={data.error} onRetry={() => data.reload()} testId="health-error" /><EmptyState title="検診を読み込めませんでした" /></div>;
  const items = data.data.items;
  const save = async () => {
    const body: Record<string, unknown> = { checkup_date: f.checkup_date, notes: f.notes?.trim() || null };
    for (const c of CHECKUP_FIELDS) body[c.key] = numOrNull(f[c.key] ?? "");
    setSaving(true);
    try { await api.post("/health/checkups", body); toast("保存しました", "success"); setF({ checkup_date: f.checkup_date }); reload(); }
    catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setSaving(false); }
  };
  const del = async (c: Checkup) => { if (!confirm(`${fmtDate(c.checkup_date)} の検診記録を削除しますか？`)) return; try { await api.del(`/health/checkups/${c.id}`); toast("削除しました"); reload(); } catch (e: any) { toast(e?.message ?? "削除できませんでした", "error"); } };
  return (
    <div className="space-y-4">
      <Card as="section" className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">検診結果を登録</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="受診日" className="col-span-2 sm:col-span-1"><Input type="date" value={f.checkup_date} onChange={(e) => setF({ ...f, checkup_date: e.target.value })} data-testid="checkup-date" /></Field>
          {CHECKUP_FIELDS.map((c) => <Field key={c.key} label={`${c.label} (${c.unit})`}><Input inputMode="decimal" value={f[c.key] ?? ""} onChange={(e) => setF({ ...f, [c.key]: e.target.value })} placeholder="—" data-testid={`checkup-${c.key}`} /></Field>)}
        </div>
        <Field label="メモ"><Textarea value={f.notes ?? ""} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="医師のコメントなど" className="min-h-16" /></Field>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-label-3">検査値から診断や治療方針を決める機能ではありません。</p>
          <Button variant="primary" onClick={save} loading={saving} disabled={!/^\d{4}-\d{2}-\d{2}$/.test(f.checkup_date)} data-testid="checkup-save">保存</Button>
        </div>
      </Card>
      <Section title="履歴">
        {items.length === 0 ? <Card><EmptyState title="検診記録がありません" hint="年1回程度の更新を想定しています。" /></Card> : (
          <Card padded={false}>
            <Table testId="checkup-table">
              <thead><tr><Th className="sticky left-0 bg-elevated">受診日</Th>{CHECKUP_FIELDS.map((c) => <Th key={c.key} align="right">{c.label}<span className="block font-normal text-label-3">{c.unit}</span></Th>)}<Th>メモ</Th><Th><span className="sr-only">操作</span></Th></tr></thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className={trCls} data-testid="checkup-row">
                    <Td className="font-medium sticky left-0 bg-elevated">{c.checkup_date}</Td>
                    {CHECKUP_FIELDS.map((x) => <Td key={x.key} align="right" className={c[x.key] == null ? "text-label-3" : undefined}>{c[x.key] == null ? "—" : fmtNum(c[x.key], x.key === "hba1c" || x.key === "creatinine" || x.key === "uric_acid" ? 1 : 0)}</Td>)}
                    <Td className="text-label-2 max-w-[16rem] truncate">{c.notes ?? "—"}</Td>
                    <Td className="px-2"><IconButton label={`${fmtDate(c.checkup_date)} の記録を削除`} className="text-red hover:text-red" onClick={() => del(c)}>✕</IconButton></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </Section>
    </div>
  );
}

