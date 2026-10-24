/** よく食べるもの and セット: create, edit, remove. Changes show at once; values fill in from the 成分表 in the background. */
import { useState } from "react";
import { Icon } from "@/components/icons";
import { Badge, Button, EmptyState, IconButton, Input, Segmented, Select, Spinner, useToast } from "@/components/ui";
import { api, fmtNum, fmtYen } from "@/lib/api";
import { parseFoodInput } from "@shared/meals";
import { Sheet } from "./Sheet";
import { SOURCE, amountText, summarize, type DayRes, type Food, type MealSet, type SetItem } from "./model";
import type { LookupState } from "./store";

type Patch = (fn: (p: DayRes) => DayRes) => void;
const errText = (e: unknown, fb: string) => (e as { message?: string })?.message || fb;
/** Set totals recomputed locally after a member change. */
const withTotals = (s: MealSet, items: SetItem[]): MealSet => {
  const x = summarize(items.map((m) => ({ nutrition: m.nutrition, nutrition_source: m.nutrition_source, cost: m.cost_per_serving })));
  return { ...s, items, nutrition: x.nutrition, cost: x.cost };
};

export function LibrarySheet({ open, onClose, foods, sets, patch, resolve, lookups, onEditFood, onEditItem, initialTab = "foods" }: {
  open: boolean; onClose: () => void; foods: Food[]; sets: MealSet[]; patch: Patch; lookups: Record<string, LookupState>;
  resolve: (kind: "food" | "item", id: string, o?: { quiet?: boolean }) => Promise<boolean>; onEditFood: (f: Food) => void; onEditItem: (m: SetItem) => void; initialTab?: "foods" | "sets";
}) {
  const [tab, setTab] = useState<"foods" | "sets">(initialTab);
  return (
    <Sheet open={open} onClose={onClose} title="よく食べるもの・セット" wide testId="library-sheet">
      <Segmented<"foods" | "sets"> value={tab} onChange={setTab} className="mb-4" options={[{ value: "foods", label: `よく食べるもの ${foods.length}` }, { value: "sets", label: `セット ${sets.length}` }]} />
      {tab === "foods" ? <Foods foods={foods} patch={patch} resolve={resolve} lookups={lookups} onEdit={onEditFood} /> : <Sets sets={sets} foods={foods} patch={patch} resolve={resolve} lookups={lookups} onEditItem={onEditItem} />}
    </Sheet>
  );
}

function AddLine({ placeholder, onAdd, testId, label }: { placeholder: string; onAdd: (text: string) => Promise<void> | void; testId: string; label: string }) {
  const [t, setT] = useState("");
  return (
    <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); const v = t.trim(); if (!v) return; setT(""); await onAdd(v); }}>
      <Input value={t} onChange={(e) => setT(e.target.value)} placeholder={placeholder} aria-label={label} data-testid={testId} />
      <Button type="submit" variant="primary" disabled={!t.trim()} data-testid={`${testId}-submit`}>追加</Button>
    </form>
  );
}

function NutritionLine({ n, source, busy, note }: { n: Record<string, number> | null; source: string | null; busy?: boolean; note?: string }) {
  if (busy && !n) return <span className="flex items-center gap-1.5 text-xs text-label-2"><Spinner className="size-3" />成分表で計算中</span>;
  if (!n) return <span className="text-xs text-orange">{note ?? "栄養未計算"}</span>;
  const s = source ? SOURCE[source] : null;
  return <span className="flex items-center gap-1.5 text-xs text-label-3 tabular">{s && <Badge tone={s.tone}>{s.label}</Badge>}{fmtNum(n.energy_kcal)} kcal・P {fmtNum(n.protein_g, 1)}</span>;
}

function Foods({ foods, patch, resolve, lookups, onEdit }: { foods: Food[]; patch: Patch; resolve: (k: "food", id: string, o?: { quiet?: boolean }) => Promise<boolean>; lookups: Record<string, LookupState>; onEdit: (f: Food) => void }) {
  const toast = useToast();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const missing = foods.filter((f) => !f.nutrition);
  const add = async (text: string) => {
    const q = parseFoodInput(text);
    try {
      const r = await api.post<{ item: Food; needs_lookup: boolean }>("/health/meals/foods", { name: q.name, amount: q.amount, unit: q.unit });
      patch((p) => ({ ...p, foods: [...p.foods, r.item] }));
      if (r.needs_lookup) resolve("food", r.item.id, { quiet: true });
    } catch (e) { toast(errText(e, "追加できませんでした"), "error"); }
  };
  const fillAll = async () => {
    setProgress({ done: 0, total: missing.length });
    let ok = 0;
    for (const [i, f] of missing.entries()) { if (await resolve("food", f.id, { quiet: true })) ok++; setProgress({ done: i + 1, total: missing.length }); }
    setProgress(null);
    toast(`成分表で${ok}件を計算しました${missing.length - ok ? `（${missing.length - ok}件は見つからないため未計算のまま）` : ""}`, ok ? "success" : "neutral");
  };
  return (
    <div className="space-y-4">
      <AddLine placeholder="名前と量（例: 納豆 1パック）" onAdd={add} testId="food-new" label="よく食べるものを追加" />
      {missing.length > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] bg-subtle px-3 py-2 text-sm">
          <span className="text-label-2">{missing.length}件の栄養が未計算です</span>
          <Button size="sm" variant="tinted" onClick={fillAll} disabled={Boolean(progress)} data-testid="foods-recalc">{progress ? <><Spinner className="size-3.5" />{progress.done}/{progress.total}</> : "成分表で計算"}</Button>
        </div>
      )}
      {foods.length === 0 ? <EmptyState title="まだありません" hint="よく食べるものを登録すると、記録画面から1タップで追加できます。" /> : (
        <ul className="divide-y divide-separator rounded-[var(--radius-md)] bg-fill/40" data-testid="food-list">
          {foods.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => onEdit(f)} className="focus-ring w-full flex items-center gap-3 px-3 min-h-14 py-2 text-left hover:bg-fill" aria-label={`${f.name}を編集`} data-testid="food-row">
                <span className="flex-1 min-w-0">
                  <span className="block font-medium truncate">{f.name}<span className="text-sm text-label-2 font-normal tabular ml-2">{f.amount != null ? amountText(f.amount, f.unit) : ""}</span></span>
                  <NutritionLine n={f.nutrition} source={f.nutrition_source} busy={lookups[f.id]?.busy} note={lookups[f.id]?.note} />
                </span>
                <span className="text-xs text-label-3 tabular shrink-0">{f.cost_per_serving != null ? fmtYen(f.cost_per_serving) : ""}{f.use_count ? ` ${f.use_count}回` : ""}</span>
                <Icon name="chevron-right" size={16} className="text-label-3 shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Sets({ sets, foods, patch, resolve, lookups, onEditItem }: { sets: MealSet[]; foods: Food[]; patch: Patch; resolve: (k: "item", id: string, o?: { quiet?: boolean }) => Promise<boolean>; lookups: Record<string, LookupState>; onEditItem: (m: SetItem) => void }) {
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(sets.length === 1 ? sets[0]!.id : null);
  const setSet = (id: string, fn: (s: MealSet) => MealSet) => patch((p) => ({ ...p, sets: p.sets.map((s) => (s.id === id ? fn(s) : s)) }));
  const create = async (name: string) => {
    try { const r = await api.post<{ item: MealSet }>("/health/meals/sets", { name }); patch((p) => ({ ...p, sets: [...p.sets, r.item] })); setOpenId(r.item.id); }
    catch (e) { toast(errText(e, "作成できませんでした"), "error"); }
  };
  const rename = async (s: MealSet, name: string) => {
    setSet(s.id, (x) => ({ ...x, name }));
    try { await api.put(`/health/meals/sets/${s.id}`, { name }); } catch (e) { setSet(s.id, (x) => ({ ...x, name: s.name })); toast(errText(e, "保存できませんでした"), "error"); }
  };
  const remove = async (s: MealSet) => {
    if (!confirm(`セット「${s.name}」を削除しますか？（過去の記録は残ります）`)) return;
    patch((p) => ({ ...p, sets: p.sets.filter((x) => x.id !== s.id) }));
    try { await api.del(`/health/meals/sets/${s.id}`); } catch (e) { patch((p) => ({ ...p, sets: [...p.sets, s] })); toast(errText(e, "削除できませんでした"), "error"); }
  };
  const addItem = async (s: MealSet, body: Record<string, unknown>) => {
    try {
      const r = await api.post<{ item: SetItem; needs_lookup: boolean }>(`/health/meals/sets/${s.id}/items`, body);
      setSet(s.id, (x) => withTotals(x, [...x.items, r.item]));
      if (r.needs_lookup) resolve("item", r.item.id, { quiet: true }).then(() => {});
    } catch (e) { toast(errText(e, "追加できませんでした"), "error"); }
  };
  const removeItem = async (s: MealSet, m: SetItem) => {
    setSet(s.id, (x) => withTotals(x, x.items.filter((i) => i.id !== m.id)));
    try { await api.del(`/health/meals/sets/${s.id}/items/${m.id}`); } catch (e) { setSet(s.id, (x) => withTotals(x, [...x.items, m])); toast(errText(e, "外せませんでした"), "error"); }
  };
  return (
    <div className="space-y-4">
      <AddLine placeholder="新しいセットの名前（例: いつもの朝食）" onAdd={create} testId="set-name" label="セットを作成" />
      {sets.length === 0 && <EmptyState title="セットがありません" hint="一緒に食べる組み合わせをセットにすると、1タップでまとめて記録できます。記録画面の「セットとして保存」からも作れます。" />}
      {sets.map((s) => {
        const on = openId === s.id;
        return (
          <div key={s.id} className="rounded-[var(--radius-lg)] bg-subtle" data-testid="set-row">
            <button type="button" onClick={() => setOpenId(on ? null : s.id)} aria-expanded={on} className="focus-ring w-full flex items-center gap-3 px-4 min-h-14 text-left rounded-[var(--radius-lg)]">
              <span className="flex-1 min-w-0"><span className="block font-medium truncate">{s.name}</span>
                <span className="block text-xs text-label-2 tabular">{s.items.length}品{s.nutrition.totals.energy_kcal != null ? `・${fmtNum(s.nutrition.totals.energy_kcal)} kcal${s.nutrition.partial && s.items.length ? "（一部未計算）" : ""}` : ""}{s.cost.total != null ? `・${fmtYen(s.cost.total)}` : ""}</span></span>
              <Icon name={on ? "chevron-up" : "chevron-down"} size={18} className="text-label-3" />
            </button>
            {on && (
              <div className="px-4 pb-4 space-y-3">
                <ul className="divide-y divide-separator rounded-[var(--radius-md)] bg-elevated/60">
                  {s.items.map((m) => (
                    <li key={m.id} className="flex items-center gap-1 pr-1">
                      <button type="button" onClick={() => onEditItem(m)} className="focus-ring flex-1 min-w-0 text-left px-3 py-2 min-h-12" aria-label={`${m.food_name}を編集`}>
                        <span className="block text-sm truncate">{m.food_name}<span className="text-label-2 tabular ml-1.5">{m.amount != null ? amountText(m.amount, m.unit) : ""}</span></span>
                        <NutritionLine n={m.nutrition} source={m.nutrition_source} busy={lookups[m.id]?.busy} note={lookups[m.id]?.note} />
                      </button>
                      <IconButton label={`${m.food_name}をセットから外す`} className="hover:text-red" onClick={() => removeItem(s, m)}><Icon name="close" size={16} /></IconButton>
                    </li>
                  ))}
                  {s.items.length === 0 && <li className="px-3 py-3 text-sm text-label-3">まだ食品がありません。</li>}
                </ul>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Select value="" onChange={(e) => { const fid = e.target.value; if (fid) addItem(s, { food_id: fid }); }} aria-label={`${s.name}によく食べるものを追加`} data-testid="set-item-add">
                    <option value="">よく食べるものから追加…</option>
                    {foods.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </Select>
                  <AddLine placeholder="名前と量で追加" onAdd={(t) => { const q = parseFoodInput(t); return addItem(s, { name: q.name, amount: q.amount, unit: q.unit }); }} testId="set-item-new" label={`${s.name}に食品を追加`} />
                </div>
                <div className="flex items-center gap-2">
                  <RenameField value={s.name} onSave={(v) => rename(s, v)} />
                  <Button size="sm" variant="danger" onClick={() => remove(s)}>削除</Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RenameField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <form className="flex-1 flex gap-2" onSubmit={(e) => { e.preventDefault(); const t = v.trim(); if (t && t !== value) onSave(t); }}>
      <Input value={v} onChange={(e) => setV(e.target.value)} aria-label="セットの名前" className="h-9" />
      {v.trim() && v.trim() !== value && <Button size="sm" type="submit">名前を保存</Button>}
    </form>
  );
}
