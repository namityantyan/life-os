/**
 * 食事: a log of what was actually eaten each day. Saved sets ("いつもの食事") and saved foods
 * ("よく食べるもの") are added with one tap; nutrition is copied into the entry at that moment.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Badge, Button, Card, ChatPanel, EmptyState, ErrorBanner, Field, IconButton, Input, Item, Modal,
  PageSkeleton, Section, Select, Stagger, cx, useToast, type ChatMsg,
} from "@/components/ui";
import { api, useApi, fmtNum, fmtYen, fmtDate, todayJst } from "@/lib/api";
import { ALL_NUTRIENTS, EXTRA_NUTRIENTS, MAIN_NUTRIENTS, NutrientBar, nutrientLabel, numOrNull, type ChatItem, type Nutrition } from "./shared";

type Food = { id: string; name: string; amount: number | null; unit: string | null; nutrition: Nutrition | null; nutrition_source: string | null; cost_per_serving: number | null; use_count: number };
type SetItem = { id: string; food_name: string; amount: number | null; unit: string | null; nutrition: Nutrition | null; cost_per_serving: number | null };
type MealSet = { id: string; name: string; items: SetItem[]; nutrition: { totals: Record<string, number | null>; partial: boolean }; cost: { total: number | null; missing: number } };
type Entry = { id: string; day: string; food_name: string; amount: number | null; unit: string | null; nutrition: Nutrition | null; nutrition_source: string | null; cost: number | null; servings: number };
type Summary = { nutrition: { totals: Record<string, number | null>; partial: boolean; item_count: number; with_nutrition: number; estimated_count: number }; cost: { total: number | null; counted: number; missing: number }; targets: Nutrition };
type DayRes = { day: string; entries: Entry[]; summary: Summary; foods: Food[]; sets: MealSet[] };

const shiftDay = (day: string, delta: number) => new Date(Date.parse(day + "T00:00:00Z") + delta * 86400e3).toISOString().slice(0, 10);
const dayLabel = (day: string) => {
  const today = todayJst();
  if (day === today) return "今日";
  if (day === shiftDay(today, -1)) return "昨日";
  const d = new Date(day + "T00:00:00Z");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${["日", "月", "火", "水", "木", "金", "土"][d.getUTCDay()]}）`;
};

/* ---------------------------------------------------------------- chat */
function useChat(channel: "meal") {
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
  const markApplied = useCallback((id: string, applied: Record<string, unknown>) => setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, applied } : m))), []);
  return { messages, busy, send, markApplied };
}

/* ---------------------------------------------------------------- page */
export function MealTab() {
  const toast = useToast();
  const [day, setDay] = useState(todayJst());
  const d = useApi<DayRes>(`/health/meals/day?day=${day}`, { deps: [day] });
  const history = useApi<{ items: { day: string; count: number; nutrition: { totals: Record<string, number | null> } }[] }>("/health/meals/days?limit=10");
  const chat = useChat("meal");
  const [editing, setEditing] = useState<Entry | "new" | null>(null);
  const [foodEditing, setFoodEditing] = useState<Food | "new" | null>(null);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [setsOpen, setSetsOpen] = useState(false);
  const [showExtra, setShowExtra] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [estimating, setEstimating] = useState<string | null>(null);

  const reload = useCallback(() => { d.reload(true); history.reload(true); }, [d, history]);
  const data = d.data;
  /** Write-endpoints return the day log only, so merge it into the cached day (keeping foods/sets). */
  const apply = useCallback((res: Partial<DayRes>) => {
    d.setData((prev) => (prev ? { ...prev, ...res, foods: res.foods ?? prev.foods, sets: res.sets ?? prev.sets } : (res as DayRes)));
    history.reload(true);
  }, [d, history]);

  if (d.loading && !data) return <PageSkeleton cards={3} />;
  if (!data?.summary) return <div><ErrorBanner message={d.error} onRetry={() => d.reload()} testId="health-error" /><EmptyState title="食事を読み込めませんでした" /></div>;
  const entries = data.entries ?? [], savedFoods = data.foods ?? [], mealSets = data.sets ?? [];
  const { totals, partial, item_count, with_nutrition, estimated_count } = data.summary.nutrition;
  const cost = data.summary.cost; const targets = data.summary.targets;

  const addSet = async (s: MealSet) => {
    setAdding(s.id);
    try { const r = await api.post<DayRes & { added: number }>(`/health/meals/sets/${s.id}/add`, { day }); apply(r); toast(`${s.name}の${r.added}件を追加しました`, "success"); }
    catch (e: any) { toast(e?.message ?? "追加できませんでした", "error"); } finally { setAdding(null); }
  };
  const addFood = async (f: Food) => {
    setAdding(f.id);
    try {
      const r = await api.post<DayRes>("/health/meals/entries", { day, food_id: f.id, food_name: f.name, amount: f.amount, unit: f.unit, nutrition: f.nutrition, nutrition_source: f.nutrition_source, cost: f.cost_per_serving });
      apply(r); toast(`${f.name}を追加しました`, "success");
    } catch (e: any) { toast(e?.message ?? "追加できませんでした", "error"); } finally { setAdding(null); }
  };
  const removeEntry = async (e: Entry) => {
    try { apply(await api.del<DayRes>(`/health/meals/entries/${e.id}`)); toast("削除しました"); }
    catch (err: any) { toast(err?.message ?? "削除できませんでした", "error"); }
  };
  const estimateEntry = async (e: Entry) => {
    setEstimating(e.id);
    try {
      let r = await api.post<{ applied: boolean; reason?: string }>(`/health/meals/entry/${e.id}/estimate`, {});
      if (!r.applied && r.reason === "recorded") {
        if (!confirm(`「${e.food_name}」には記録済みの栄養値があります。推定値で上書きしますか？`)) return;
        r = await api.post(`/health/meals/entry/${e.id}/estimate`, { confirm: true });
      }
      if (r.applied) { toast("推定値を保存しました", "success"); reload(); }
      else if (r.reason === "ai_unavailable") toast("AIに接続できないため推定できません", "error");
    } catch (err: any) { toast(err?.message ?? "推定に失敗しました", "error"); } finally { setEstimating(null); }
  };
  const clearDay = async () => {
    if (!confirm(`${dayLabel(day)}の記録をすべて削除しますか？`)) return;
    try { apply(await api.del<DayRes>(`/health/meals/day/${day}`)); toast("記録を削除しました"); }
    catch (e: any) { toast(e?.message ?? "削除できませんでした", "error"); }
  };

  return (
    <div className="grid gap-4 grid-cols-1 xl:grid-cols-3">
      <div className="xl:col-span-2 space-y-4">
        {/* ---- day picker + totals ---- */}
        <Card as="section" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <IconButton label="前の日" onClick={() => setDay(shiftDay(day, -1))} data-testid="day-prev">‹</IconButton>
              <span className="font-semibold tracking-tight tabular min-w-24 text-center" data-testid="day-label">{dayLabel(day)}</span>
              <IconButton label="次の日" onClick={() => setDay(shiftDay(day, 1))} data-testid="day-next" disabled={day >= todayJst()}>›</IconButton>
              {day !== todayJst() && <Button size="sm" variant="ghost" onClick={() => setDay(todayJst())}>今日へ</Button>}
            </div>
            <div className="flex items-center gap-2">
              {item_count > 0 && (partial ? <Badge tone="orange"><span data-testid="nutrition-partial">途中の値（{with_nutrition}/{item_count}件が計算済み）</span></Badge> : <Badge tone="green"><span data-testid="nutrition-complete">全件計算済み</span></Badge>)}
              {estimated_count > 0 && <Badge>推定を含む {estimated_count}件</Badge>}
              <Button size="sm" onClick={() => setTargetsOpen(true)} data-testid="targets-edit">目標を編集</Button>
            </div>
          </div>
          {item_count === 0 ? <p className="text-sm text-label-3">まだ記録がありません。下のボタンから追加できます。</p> : (
            <div className="space-y-2">
              {(showExtra ? ALL_NUTRIENTS : MAIN_NUTRIENTS).map((n) => <NutrientBar key={n.key} label={n.label} unit={n.unit} value={totals[n.key] ?? null} target={targets[n.key] ?? null} partial={partial} />)}
              <Button size="sm" variant="ghost" aria-expanded={showExtra} onClick={() => setShowExtra((v) => !v)}>{showExtra ? "主要項目だけ表示" : "ミネラル・ビタミンも表示"}</Button>
              {partial && <p className="text-xs text-label-2">栄養が未計算の記録があるため、合計は途中の値です。不足・過剰は断定しません。</p>}
            </div>
          )}
          <div className="flex items-baseline gap-2 pt-1">
            <span className="text-xs text-label-2 font-medium">食費（概算）</span>
            <span className="text-lg font-semibold tabular" data-testid="meal-cost-total">{cost.total == null ? "未入力" : fmtYen(cost.total)}</span>
            {cost.missing > 0 && <span className="text-xs text-label-3">費用未入力 {cost.missing}件（無料とは扱いません）</span>}
          </div>
        </Card>

        {/* ---- one-tap add ---- */}
        <Section title="ボタンで追加" action={<Button size="sm" variant="ghost" onClick={() => setSetsOpen(true)} data-testid="sets-manage">セットを管理</Button>}>
          <Card className="space-y-3">
            {mealSets.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-label-2">いつもの食事</div>
                <div className="flex flex-wrap gap-2" data-testid="set-buttons">
                  {mealSets.map((s) => (
                    <Button key={s.id} variant="tinted" loading={adding === s.id} onClick={() => addSet(s)} disabled={s.items.length === 0} data-testid={`set-add-${s.name}`}
                      title={s.items.map((i) => i.food_name).join("、")}>
                      {s.name}
                      <span className="text-xs opacity-70 ml-1">{s.items.length}品{s.nutrition.totals.energy_kcal != null ? `・${fmtNum(s.nutrition.totals.energy_kcal)}kcal` : ""}</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-label-2">よく食べるもの</span>
                <Button size="sm" variant="ghost" onClick={() => setFoodEditing("new")} data-testid="food-add">登録を追加</Button>
              </div>
              {savedFoods.length === 0 ? <p className="text-sm text-label-3">まだありません。食べたものを記録するとき「よく食べるものに登録」を選ぶと、次から1タップで追加できます。</p> : (
                <div className="flex flex-wrap gap-2" data-testid="food-buttons">
                  {savedFoods.map((f) => (
                    <div key={f.id} className="group relative">
                      <Button variant="secondary" loading={adding === f.id} onClick={() => addFood(f)} data-testid={`food-add-${f.name}`}
                        title={[f.amount != null ? `${fmtNum(f.amount, 1)}${f.unit ?? ""}` : null, f.nutrition?.energy_kcal != null ? `${fmtNum(f.nutrition.energy_kcal)}kcal` : "栄養未計算", f.cost_per_serving != null ? fmtYen(f.cost_per_serving) : null].filter(Boolean).join("・")}>
                        {f.name}
                        {f.nutrition?.energy_kcal != null && <span className="text-xs opacity-60 ml-1 tabular">{fmtNum(f.nutrition.energy_kcal)}</span>}
                      </Button>
                      <button className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-fill-strong text-label-2 text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity" aria-label={`${f.name}を編集`} onClick={() => setFoodEditing(f)}>✎</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <Button variant="primary" className="w-full" onClick={() => setEditing("new")} data-testid="entry-add">食べたものを記録</Button>
          </Card>
        </Section>

        {/* ---- the day's entries ---- */}
        <Section title={`${dayLabel(day)}の記録`} action={entries.length > 0 ? <Button size="sm" variant="danger" onClick={clearDay} data-testid="day-clear">すべて削除</Button> : undefined}>
          {entries.length === 0 ? <Card><EmptyState title="記録がありません" hint="セットやよく食べるものから、ボタンひとつで追加できます。" /></Card> : (
            <Card padded={false} className="px-5 py-2">
              <Stagger className="divide-y divide-separator">
                {entries.map((e) => (
                  <Item key={e.id} className="flex items-center gap-3 py-2.5">
                    <div className="flex-1 min-w-0" data-testid="meal-item">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{e.food_name}</span>
                        {e.servings !== 1 && <Badge>×{fmtNum(e.servings, 1)}</Badge>}
                        {e.amount != null && <span className="text-sm text-label-2 tabular">{fmtNum(e.amount, 1)}{e.unit ?? ""}</span>}
                        {e.nutrition_source === "recorded" ? <Badge tone="green">記録</Badge> : e.nutrition_source === "estimated" ? <Badge tone="accent">推定</Badge> : <Badge>栄養未計算</Badge>}
                      </div>
                      <div className="text-xs text-label-3 tabular">{e.nutrition ? `${fmtNum(e.nutrition.energy_kcal)} kcal・P ${fmtNum(e.nutrition.protein_g)}・F ${fmtNum(e.nutrition.fat_g)}・C ${fmtNum(e.nutrition.carbs_g)}` : "—"}・{e.cost == null ? "費用未入力" : fmtYen(e.cost)}</div>
                    </div>
                    {!e.nutrition && <Button size="sm" variant="ghost" onClick={() => estimateEntry(e)} loading={estimating === e.id} aria-label={`${e.food_name}の栄養をAIで推定`} data-testid="meal-estimate">AI推定</Button>}
                    <Button size="sm" variant="ghost" onClick={() => setEditing(e)} aria-label={`${e.food_name}を編集`}>編集</Button>
                    <IconButton label={`${e.food_name}を削除`} className="text-red hover:text-red" onClick={() => removeEntry(e)}>✕</IconButton>
                  </Item>
                ))}
              </Stagger>
            </Card>
          )}
          {(history.data?.items.length ?? 0) > 1 && (
            <div className="flex flex-wrap gap-2 pt-1" data-testid="day-history">
              {history.data!.items.map((h) => (
                <button key={h.day} onClick={() => setDay(h.day)} className={cx("focus-ring rounded-[var(--radius-md)] px-2.5 py-1.5 text-xs transition-colors", h.day === day ? "bg-accent-soft text-accent" : "bg-fill text-label-2 hover:text-label")}>
                  <span className="tabular">{fmtDate(h.day + "T00:00:00Z")}</span>
                  <span className="ml-1 opacity-70">{h.nutrition.totals.energy_kcal != null ? `${fmtNum(h.nutrition.totals.energy_kcal)}kcal` : `${h.count}件`}</span>
                </button>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* ---- chat ---- */}
      <Card as="section" className="xl:col-span-1 flex flex-col xl:sticky xl:top-20 self-start w-full">
        <h2 className="text-lg font-semibold tracking-tight mb-2">食事チャット</h2>
        <ChatPanel messages={chat.messages} onSend={chat.send} busy={chat.busy} placeholder="例: ゆで卵2個を食べた / たんぱく質の目標を120gに"
          emptyHint="その日の記録と目標をもとに相談できます。食べたものの追加や目標の変更を頼むと、反映できる提案が出ます。"
          renderExtra={(m) => {
            const it = m as ChatItem;
            return it.proposal && (it.proposal.error || it.proposal.entries?.length || it.proposal.targets)
              ? <ProposalCard item={it} entries={entries} targets={targets} day={day} onApplied={(res, applied) => { chat.markApplied(it.id!, applied); apply(res); }} />
              : null;
          }} />
      </Card>

      <EntryModal entry={editing} day={day} foods={savedFoods} onClose={() => setEditing(null)} onSaved={(res, savedFood) => { setEditing(null); apply(res); if (savedFood) d.reload(true); }} />
      <FoodModal food={foodEditing} onClose={() => setFoodEditing(null)} onSaved={() => { setFoodEditing(null); reload(); }} />
      <TargetsModal open={targetsOpen} targets={targets} onClose={() => setTargetsOpen(false)} onSaved={() => { setTargetsOpen(false); reload(); }} />
      <SetsModal open={setsOpen} sets={mealSets} foods={savedFoods} onClose={() => setSetsOpen(false)} onChanged={reload} />
    </div>
  );
}

/* ---------------------------------------------------------------- proposal card */
type LogOp =
  | { op: "add"; food_name: string; amount: number | null; unit: string | null; cost: number | null; nutrition: Nutrition | null; save_as_food: boolean }
  | { op: "update"; id: string; food_name: string; changes: { food_name?: string; amount?: number | null; unit?: string | null; cost?: number | null; nutrition?: Nutrition | null } }
  | { op: "remove"; id: string; food_name: string };

const amountText = (a: number | null | undefined, u: string | null | undefined) => (a == null ? "量未設定" : `${fmtNum(a, 1)}${u ?? ""}`);
const kcalText = (n: Nutrition | null | undefined) => (n?.energy_kcal != null ? `約${fmtNum(n.energy_kcal)}kcal` : null);

function ProposalCard({ item, entries, targets, day, onApplied }: {
  item: ChatItem; entries: Entry[]; targets: Nutrition; day: string; onApplied: (res: DayRes, applied: Record<string, unknown>) => void;
}) {
  const toast = useToast();
  const p = item.proposal as { entries?: LogOp[]; targets?: Nutrition | null; error?: string };
  const ops = p.entries ?? [];
  const targetRows = Object.entries(p.targets ?? {}).filter(([k, v]) => targets[k] !== v);
  const [sel, setSel] = useState<Set<number>>(() => new Set(ops.map((_, i) => i)));
  const [useTargets, setUseTargets] = useState(targetRows.length > 0);
  const [busy, setBusy] = useState(false);
  const applied = item.applied;
  const count = sel.size + (useTargets ? 1 : 0);

  if (p.error) return <div className="mt-2 rounded-[var(--radius-lg)] bg-orange/10 p-3 text-sm text-label-2" data-testid="meal-proposal-error">{p.error}</div>;

  const describe = (op: LogOp) => {
    if (op.op === "add") return { tag: "記録に追加", tone: "green" as const, text: `${op.food_name} ${amountText(op.amount, op.unit)}`, sub: [kcalText(op.nutrition), op.nutrition ? "栄養は推定" : "栄養未計算", op.cost != null ? fmtYen(op.cost) : null, op.save_as_food ? "よく食べるものにも登録" : null].filter(Boolean).join("・") };
    if (op.op === "remove") { const cur = entries.find((m) => m.id === op.id); return { tag: "削除", tone: "red" as const, text: op.food_name, sub: cur ? amountText(cur.amount, cur.unit) : "" }; }
    const cur = entries.find((m) => m.id === op.id); const ch = op.changes; const parts: string[] = [];
    if (ch.food_name) parts.push(`名前 → ${ch.food_name}`);
    if (ch.amount !== undefined) parts.push(`${amountText(cur?.amount, cur?.unit)} → ${amountText(ch.amount, ch.unit ?? cur?.unit)}`);
    if (ch.cost !== undefined) parts.push(`費用 → ${ch.cost == null ? "未入力" : fmtYen(ch.cost)}`);
    if (ch.nutrition) parts.push(`栄養 → ${kcalText(ch.nutrition) ?? "更新"}（推定）`);
    else if (ch.amount != null && cur?.nutrition) parts.push("栄養は量に合わせて換算（推定）");
    return { tag: "変更", tone: "accent" as const, text: op.food_name, sub: parts.join("、") };
  };

  const applyNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<DayRes & { added: number; updated: number; removed: number; targets: boolean; skipped: number }>("/health/meals/apply-proposal", {
        message_id: item.id, day, entries: ops.filter((_, i) => sel.has(i)), targets: useTargets ? Object.fromEntries(targetRows) : null,
      });
      const msg = [r.added && `追加${r.added}件`, r.updated && `変更${r.updated}件`, r.removed && `削除${r.removed}件`, r.targets && "目標を更新"].filter(Boolean).join("・");
      toast(msg ? `反映しました（${msg}）` : "反映できる変更がありませんでした", msg ? "success" : "neutral");
      if (r.skipped) toast(`${r.skipped}件は現在の記録と合わないため反映しませんでした`);
      onApplied(r, { added: r.added, updated: r.updated, removed: r.removed, targets: r.targets, at: new Date().toISOString() });
    } catch (e: any) { toast(e?.message ?? "反映に失敗しました", "error"); } finally { setBusy(false); }
  };

  return (
    <div className="mt-2 rounded-[var(--radius-lg)] bg-subtle p-3 space-y-2 text-sm" data-testid="meal-proposal">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">提案された変更</span>
        {applied ? <Badge tone="green"><span data-testid="meal-proposal-applied">反映済み</span></Badge> : null}
      </div>
      {ops.length > 0 && (
        <ul className="space-y-1.5" data-testid="meal-proposal-ops">
          {ops.map((op, i) => { const dsc = describe(op); return (
            <li key={i}>
              <label className={cx("flex items-start gap-2", applied && "opacity-60")}>
                <input type="checkbox" className="mt-1 accent-[var(--accent)] size-4 shrink-0" checked={sel.has(i)} disabled={!!applied || busy}
                  onChange={(e) => setSel((s0) => { const n = new Set(s0); if (e.target.checked) n.add(i); else n.delete(i); return n; })} aria-label={`${dsc.tag} ${dsc.text}`} />
                <span className="min-w-0"><Badge tone={dsc.tone} className="mr-1.5">{dsc.tag}</Badge><span>{dsc.text}</span>{dsc.sub && <span className="block text-xs text-label-2 mt-0.5">{dsc.sub}</span>}</span>
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
        <Button size="sm" variant="primary" className="w-full" loading={busy} disabled={count === 0} onClick={applyNow} data-testid="meal-proposal-apply">選んだ変更を反映（{count}件）</Button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- modals */
function NutritionFields({ n, setN }: { n: Record<string, string>; setN: (v: Record<string, string>) => void }) {
  return (
    <details className="rounded-[var(--radius-md)] bg-subtle p-3">
      <summary className="text-sm font-medium cursor-pointer">栄養を手入力（記録値）</summary>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
        {ALL_NUTRIENTS.map((x) => <Field key={x.key} label={`${x.label} (${x.unit})`}><Input inputMode="decimal" value={n[x.key] ?? ""} onChange={(e) => setN({ ...n, [x.key]: e.target.value })} /></Field>)}
      </div>
      <p className="text-xs text-label-3 mt-2">空欄のままなら「AI推定」で埋められます。手入力した値は記録値として扱い、確認なしに上書きしません。</p>
    </details>
  );
}
const collectNutrition = (n: Record<string, string>): Nutrition => {
  const out: Nutrition = {};
  for (const [k, v] of Object.entries(n)) { const x = numOrNull(v); if (x != null) out[k] = x; }
  return out;
};

/** Log one item for a day; can pre-fill from a saved food and optionally save it as one. */
function EntryModal({ entry, day, foods, onClose, onSaved }: { entry: Entry | "new" | null; day: string; foods: Food[]; onClose: () => void; onSaved: (res: DayRes, savedFood: boolean) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ food_name: "", amount: "", unit: "", cost: "", servings: "1" });
  const [n, setN] = useState<Record<string, string>>({});
  const [save, setSave] = useState(true);
  const [saving, setSaving] = useState(false);
  const isEdit = entry && entry !== "new";
  useEffect(() => {
    if (isEdit) { setF({ food_name: entry.food_name, amount: entry.amount != null ? String(entry.amount) : "", unit: entry.unit ?? "", cost: entry.cost != null ? String(entry.cost) : "", servings: String(entry.servings) }); setN(Object.fromEntries(Object.entries(entry.nutrition ?? {}).map(([k, v]) => [k, String(v)]))); setSave(false); }
    else { setF({ food_name: "", amount: "", unit: "", cost: "", servings: "1" }); setN({}); setSave(true); }
  }, [entry, isEdit]);
  const pick = (name: string) => {
    const src = foods.find((x) => x.name === name); if (!src) return;
    setF((p) => ({ ...p, food_name: src.name, amount: src.amount != null ? String(src.amount) : "", unit: src.unit ?? "", cost: src.cost_per_serving != null ? String(src.cost_per_serving) : "" }));
    setN(Object.fromEntries(Object.entries(src.nutrition ?? {}).map(([k, v]) => [k, String(v)])));
    setSave(false);
  };
  const submit = async () => {
    if (!f.food_name.trim()) return;
    const nutrition = collectNutrition(n);
    const body: Record<string, unknown> = { day, food_name: f.food_name.trim(), amount: numOrNull(f.amount), unit: f.unit.trim() || null, cost: numOrNull(f.cost) };
    if (Object.keys(nutrition).length || isEdit) body.nutrition = Object.keys(nutrition).length ? nutrition : null;
    setSaving(true);
    try {
      const res = isEdit ? await api.put<DayRes>(`/health/meals/entries/${entry.id}`, body) : await api.post<DayRes>("/health/meals/entries", { ...body, servings: Number(f.servings) || 1, save_as_food: save });
      toast(isEdit ? "保存しました" : "記録しました", "success"); onSaved(res, !isEdit && save);
    } catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setSaving(false); }
  };
  return (
    <Modal open={Boolean(entry)} onClose={onClose} title={isEdit ? "記録を編集" : "食べたものを記録"}
      footer={<><Button onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={submit} loading={saving} disabled={!f.food_name.trim()} data-testid="entry-save">{isEdit ? "保存" : "記録する"}</Button></>}>
      <div className="space-y-3">
        {!isEdit && foods.length > 0 && (
          <Field label="よく食べるものから選ぶ"><Select value="" onChange={(e) => pick(e.target.value)} data-testid="entry-pick"><option value="">選択してください</option>{foods.map((x) => <option key={x.id} value={x.name}>{x.name}</option>)}</Select></Field>
        )}
        <Field label="食べたもの"><Input value={f.food_name} onChange={(e) => setF({ ...f, food_name: e.target.value })} placeholder="例: 鶏むね肉のサラダ" data-testid="entry-name" /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="量"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="150" /></Field>
          <Field label="単位"><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="g / 個 / 杯" /></Field>
          <Field label="費用（円）" hint="未入力可"><Input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} placeholder="未入力" data-testid="entry-cost" /></Field>
        </div>
        {!isEdit && (
          <div className="grid grid-cols-2 gap-3 items-end">
            <Field label="何回分" hint="2 なら栄養・費用も2倍"><Input inputMode="decimal" value={f.servings} onChange={(e) => setF({ ...f, servings: e.target.value })} data-testid="entry-servings" /></Field>
            <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" className="accent-[var(--accent)] size-4" checked={save} onChange={(e) => setSave(e.target.checked)} data-testid="entry-save-food" />よく食べるものに登録</label>
          </div>
        )}
        <NutritionFields n={n} setN={setN} />
      </div>
    </Modal>
  );
}

function FoodModal({ food, onClose, onSaved }: { food: Food | "new" | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: "", amount: "", unit: "", cost: "" });
  const [n, setN] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const isEdit = food && food !== "new";
  useEffect(() => {
    if (isEdit) { setF({ name: food.name, amount: food.amount != null ? String(food.amount) : "", unit: food.unit ?? "", cost: food.cost_per_serving != null ? String(food.cost_per_serving) : "" }); setN(Object.fromEntries(Object.entries(food.nutrition ?? {}).map(([k, v]) => [k, String(v)]))); }
    else { setF({ name: "", amount: "", unit: "", cost: "" }); setN({}); }
  }, [food, isEdit]);
  const submit = async () => {
    if (!f.name.trim()) return;
    const nutrition = collectNutrition(n);
    const body: Record<string, unknown> = { name: f.name.trim(), amount: numOrNull(f.amount), unit: f.unit.trim() || null, cost_per_serving: numOrNull(f.cost) };
    if (Object.keys(nutrition).length || isEdit) body.nutrition = Object.keys(nutrition).length ? nutrition : null;
    setSaving(true);
    try { if (isEdit) await api.put(`/health/meals/foods/${food.id}`, body); else await api.post("/health/meals/foods", body); toast("保存しました", "success"); onSaved(); }
    catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!isEdit || !confirm(`「${food.name}」を一覧から削除しますか？（過去の記録は残ります）`)) return;
    try { await api.del(`/health/meals/foods/${food.id}`); toast("削除しました"); onSaved(); } catch (e: any) { toast(e?.message ?? "削除できませんでした", "error"); }
  };
  return (
    <Modal open={Boolean(food)} onClose={onClose} title={isEdit ? "よく食べるものを編集" : "よく食べるものを追加"}
      footer={<>{isEdit && <Button variant="danger" onClick={remove}>削除</Button>}<Button onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={submit} loading={saving} disabled={!f.name.trim()} data-testid="food-save">保存</Button></>}>
      <div className="space-y-3">
        <Field label="名前"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="例: ゆで卵" data-testid="food-name" /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="量"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="1" /></Field>
          <Field label="単位"><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="個" /></Field>
          <Field label="1回分の費用（円）"><Input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} placeholder="未入力" /></Field>
        </div>
        <NutritionFields n={n} setN={setN} />
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
    setSaving(true);
    try { await api.put("/health/targets", collectNutrition(t)); toast("目標を保存しました", "success"); onSaved(); }
    catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setSaving(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="1日の栄養目標" footer={<><Button onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={save} loading={saving} data-testid="targets-save">保存</Button></>}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {ALL_NUTRIENTS.map((x) => <Field key={x.key} label={`${x.label} (${x.unit})`}><Input inputMode="decimal" value={t[x.key] ?? ""} onChange={(e) => setT({ ...t, [x.key]: e.target.value })} placeholder="未設定" /></Field>)}
      </div>
    </Modal>
  );
}

/** Manage the saved sets ("いつもの食事"): rename, add/remove members, delete. */
function SetsModal({ open, sets, foods, onClose, onChanged }: { open: boolean; sets: MealSet[]; foods: Food[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try { await fn(); if (okMsg) toast(okMsg, "success"); onChanged(); }
    catch (e: any) { toast(e?.message ?? "操作に失敗しました", "error"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="いつもの食事（セット）" wide footer={<Button onClick={onClose}>閉じる</Button>}>
      <div className="space-y-4">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) act(async () => { await api.post("/health/meals/sets", { name: name.trim() }); setName(""); }, "セットを作成しました"); }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="新しいセット名（例: いつもの朝食）" data-testid="set-name" />
          <Button type="submit" variant="primary" disabled={!name.trim() || busy} data-testid="set-create">作成</Button>
        </form>
        {sets.length === 0 && <EmptyState title="セットがありません" hint="よく食べる組み合わせをセットにすると、ボタンひとつでまとめて記録できます。" />}
        {sets.map((s) => (
          <div key={s.id} className="rounded-[var(--radius-lg)] bg-subtle p-3 space-y-2" data-testid="set-row">
            <div className="flex items-center justify-between gap-2">
              <input defaultValue={s.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.name) act(async () => { await api.put(`/health/meals/sets/${s.id}`, { name: v }); }); }}
                className="focus-ring bg-transparent font-medium rounded px-1 -mx-1 min-w-0 flex-1" aria-label={`${s.name}の名前`} />
              <span className="text-xs text-label-2 tabular shrink-0">{s.items.length}品{s.nutrition.totals.energy_kcal != null ? `・${fmtNum(s.nutrition.totals.energy_kcal)}kcal` : ""}{s.cost.total != null ? `・${fmtYen(s.cost.total)}` : ""}</span>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => { if (confirm(`「${s.name}」を削除しますか？`)) act(async () => { await api.del(`/health/meals/sets/${s.id}`); }, "削除しました"); }}>削除</Button>
            </div>
            <ul className="space-y-1">
              {s.items.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 min-w-0 truncate">{m.food_name}{m.amount != null && <span className="text-label-2 tabular"> {fmtNum(m.amount, 1)}{m.unit ?? ""}</span>}</span>
                  <IconButton label={`${m.food_name}をセットから外す`} className="text-red hover:text-red size-7" onClick={() => act(async () => { await api.del(`/health/meals/sets/${s.id}/items/${m.id}`); })}>✕</IconButton>
                </li>
              ))}
              {s.items.length === 0 && <li className="text-xs text-label-3">まだ食品がありません。</li>}
            </ul>
            <Select value="" disabled={busy} onChange={(e) => { const fid = e.target.value; if (fid) act(async () => { await api.post(`/health/meals/sets/${s.id}/items`, { food_id: fid }); }); }} aria-label={`${s.name}に食品を追加`} data-testid="set-item-add">
              <option value="">よく食べるものから追加…</option>
              {foods.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </div>
        ))}
      </div>
    </Modal>
  );
}
