/**
 * State and actions for one day's meal log. Every action updates the screen first (optimistic) and
 * talks to the server afterwards; 成分表 lookups run in the background with per-item progress.
 * Write responses are merged item by item (never by replacing the whole list), so overlapping
 * actions cannot drop each other's rows.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { parseFoodInput } from "@shared/meals";
import type { Nutrition } from "../shared";
import type { EditPatch, Editable } from "./ItemSheet";
import { forGrams, isTemp, perServing, scale, summarize, tempId, type Candidate, type DayRes, type Entry, type Food, type LookupRes, type MealSet, type SetItem } from "./model";

export type LookupState = { busy: boolean; candidates?: Candidate[]; note?: string };
const norm = (s: string) => s.normalize("NFKC").replace(/\s/g, "").toLowerCase();
const errText = (e: unknown, fb: string) => (e as { message?: string })?.message || fb;

/** Optimistic nutrition after an edit (the server's answer replaces it a moment later). */
function previewAfter(cur: { nutrition: Nutrition | null; servings: number; amount: number | null; source: Entry["nutrition_source"]; ref: Entry["nutrition_ref"] }, p: EditPatch) {
  if (p.nutrition && "table" in p.nutrition) { const t = p.nutrition.table; return { nutrition: scale(forGrams(t.per100g, t.grams), p.servings), nutrition_source: "table" as const, nutrition_ref: { number: t.number, name: t.name, grams: t.grams, grams_estimated: t.grams_estimated } }; }
  if (p.nutrition) return { nutrition: scale(p.nutrition.values, p.servings), nutrition_source: p.nutrition.values ? p.nutrition.source : null, nutrition_ref: null };
  let per = perServing(cur); let source = cur.source; let ref = cur.ref;
  if (per && p.amount && cur.amount && p.amount !== cur.amount) { per = scale(per, p.amount / cur.amount); if (source === "table" && ref) ref = { ...ref, grams: Math.round(ref.grams * (p.amount / cur.amount) * 10) / 10 }; else { source = "estimated"; ref = null; } }
  return { nutrition: scale(per, p.servings), nutrition_source: per ? source : null, nutrition_ref: per ? ref : null };
}
/** Body for PUT/POST: the patch's nutrition as the API expects it. */
export function nutritionBody(p: EditPatch): Record<string, unknown> {
  if (p.nutrition && "table" in p.nutrition) { const { number, grams, grams_estimated } = p.nutrition.table; return { table: { number, grams, grams_estimated } }; }
  if (p.nutrition) return { nutrition: p.nutrition.values, nutrition_source: p.nutrition.source };
  return {};
}

export function useMealLog(day: string) {
  const toast = useToast();
  const d = useApi<DayRes>(`/health/meals/day?day=${day}`, { quiet: true });
  const [lookups, setLookups] = useState<Record<string, LookupState>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set()); // deleted, still undoable
  const [undo, setUndo] = useState<{ entry: Entry; timer: ReturnType<typeof setTimeout> } | null>(null);
  const undoRef = useRef(undo); undoRef.current = undo;
  const dayRef = useRef(day); dayRef.current = day;

  /** Stable React keys: a saved row keeps the key of its optimistic temp row (no exit/enter flicker). */
  const keys = useRef(new Map<string, string>());
  const keyOf = useCallback((id: string) => keys.current.get(id) ?? id, []);
  const patch = useCallback((fn: (p: DayRes) => DayRes) => d.setData((prev) => (prev ? fn(prev) : prev)), [d]);
  /** Insert or replace an entry (a temp id is replaced by the saved row). Ignores rows of another day. */
  const upsert = useCallback((item: Entry, replaceId?: string) => patch((p) => {
    if (item.day !== p.day) return p;
    if (replaceId && replaceId !== item.id) keys.current.set(item.id, replaceId);
    let found = false;
    const entries = p.entries.flatMap((e) => { if (e.id === replaceId || e.id === item.id) { if (found) return []; found = true; return [item]; } return [e]; });
    if (!found) entries.push(item);
    return { ...p, entries };
  }), [patch]);
  const drop = useCallback((id: string) => patch((p) => ({ ...p, entries: p.entries.filter((e) => e.id !== id) })), [patch]);
  const setLookup = useCallback((id: string, v: LookupState | null) => setLookups((m) => { const n = { ...m }; if (v) n[id] = v; else delete n[id]; return n; }), []);

  /** Saved foods and sets changed on the server (e.g. a food got its values): refresh just those. */
  const refreshLibrary = useCallback(async () => {
    try {
      const [f, s] = await Promise.all([api.get<{ items: Food[] }>("/health/meals/foods"), api.get<{ items: MealSet[] }>("/health/meals/sets")]);
      patch((p) => ({ ...p, foods: f.items, sets: s.items }));
    } catch { /* the next visit reloads */ }
  }, [patch]);

  /** Fill an item from the 成分表 in the background. Only fills rows that are still empty / estimated. */
  const resolve = useCallback(async (kind: "entry" | "food" | "item", id: string, opts: { quiet?: boolean } = {}) => {
    setLookup(id, { busy: true });
    try {
      const r = await api.post<LookupRes>(`/health/meals/${kind}/${id}/table`, { auto: true });
      if (r.applied && r.item) {
        if (kind === "entry") { upsert(r.item as Entry); if ((r.item as Entry).food_id) refreshLibrary(); }
        else if (kind === "food") patch((p) => ({ ...p, foods: p.foods.map((f) => (f.id === id ? (r.item as unknown as Food) : f)) }));
        else patch((p) => ({ ...p, sets: p.sets.map((s) => {
          if (!s.items.some((m) => m.id === id)) return s;
          const items = s.items.map((m) => (m.id === id ? (r.item as unknown as SetItem) : m));
          const x = summarize(items.map((m) => ({ nutrition: m.nutrition, nutrition_source: m.nutrition_source, cost: m.cost_per_serving })));
          return { ...s, items, nutrition: x.nutrition, cost: x.cost };
        }) }));
        setLookup(id, { busy: false, candidates: r.candidates });
      } else setLookup(id, { busy: false, candidates: r.candidates, note: r.reason === "no_match" ? (r.note ?? "成分表に近い食品が見つかりませんでした") : undefined });
      return r.applied;
    } catch (e) {
      setLookup(id, { busy: false, note: "成分表を検索できませんでした" });
      if (!opts.quiet) toast(errText(e, "成分表を検索できませんでした"), "error");
      return false;
    }
  }, [patch, refreshLibrary, setLookup, toast, upsert]);

  const tempEntry = (over: Partial<Entry>): Entry => ({ id: tempId(), day: dayRef.current, food_name: "", amount: null, unit: null, nutrition: null, nutrition_source: null, nutrition_ref: null, cost: null, servings: 1, food_id: null, set_id: null, sort_order: 9999, ...over });

  const addFood = useCallback(async (f: Food, over?: { amount: number | null; unit: string | null; servings: number }) => {
    const servings = over?.servings ?? 1;
    const ratio = over?.amount && f.amount && (over.unit ?? f.unit) === f.unit ? over.amount / f.amount : 1;
    const t = tempEntry({ food_name: f.name, amount: over?.amount ?? f.amount, unit: over?.unit ?? f.unit, servings, food_id: f.id, nutrition: scale(scale(f.nutrition, ratio), servings), nutrition_source: f.nutrition_source, nutrition_ref: f.nutrition_ref, cost: f.cost_per_serving == null ? null : f.cost_per_serving * servings });
    patch((p) => ({ ...p, entries: [...p.entries, t], foods: p.foods.map((x) => (x.id === f.id ? { ...x, use_count: x.use_count + 1 } : x)) }));
    try {
      const r = await api.post<{ item: Entry; needs_lookup: boolean }>("/health/meals/entries", { day: t.day, food_id: f.id, food_name: f.name, servings, ...(over?.amount != null ? { amount: over.amount, unit: over.unit } : {}) });
      upsert(r.item, t.id);
      if (r.needs_lookup) resolve("entry", r.item.id, { quiet: true });
      return true;
    } catch (e) { drop(t.id); toast(errText(e, "追加できませんでした"), "error"); return false; }
  }, [drop, patch, resolve, toast, upsert]);

  /** Quick add from the text box: a saved food with the same name is reused, otherwise the 成分表 is searched. */
  const addText = useCallback(async (text: string, foods: Food[]) => {
    const q = parseFoodInput(text); if (!q.name) return false;
    const saved = foods.find((f) => norm(f.name) === norm(q.name));
    // same food, same unit (or no amount typed) → reuse the saved values; another unit → look it up afresh
    if (saved && (q.amount == null || !saved.unit || q.unit === saved.unit)) return addFood(saved, q.amount != null ? { amount: q.amount, unit: q.unit, servings: q.servings } : { amount: null, unit: null, servings: q.servings });
    const t = tempEntry({ food_name: q.name, amount: q.amount, unit: q.unit, servings: q.servings });
    patch((p) => ({ ...p, entries: [...p.entries, t] }));
    setLookup(t.id, { busy: true });
    try {
      const r = await api.post<{ item: Entry; needs_lookup: boolean }>("/health/meals/entries", { day: t.day, food_name: q.name, amount: q.amount, unit: q.unit, servings: q.servings });
      upsert(r.item, t.id); setLookup(t.id, null);
      if (r.needs_lookup) resolve("entry", r.item.id, { quiet: true });
      return true;
    } catch (e) { drop(t.id); setLookup(t.id, null); toast(errText(e, "記録できませんでした"), "error"); return false; }
  }, [addFood, drop, patch, resolve, setLookup, toast, upsert]);

  const addSet = useCallback(async (s: MealSet) => {
    const temps = s.items.map((m) => tempEntry({ food_name: m.food_name, amount: m.amount, unit: m.unit, nutrition: m.nutrition, nutrition_source: m.nutrition_source, nutrition_ref: m.nutrition_ref, cost: m.cost_per_serving, set_id: s.id }));
    patch((p) => ({ ...p, entries: [...p.entries, ...temps] }));
    try {
      const r = await api.post<{ items: Entry[]; added: number }>(`/health/meals/sets/${s.id}/add`, { day: temps[0]?.day ?? dayRef.current });
      r.items.forEach((x, i) => temps[i] && keys.current.set(x.id, temps[i]!.id));
      patch((p) => ({ ...p, entries: [...p.entries.filter((e) => !temps.some((t) => t.id === e.id) && !r.items.some((x) => x.id === e.id)), ...r.items] }));
      return true;
    } catch (e) { patch((p) => ({ ...p, entries: p.entries.filter((x) => !temps.some((t) => t.id === x.id)) })); toast(errText(e, "追加できませんでした"), "error"); return false; }
  }, [patch, toast]);

  const editEntry = useCallback(async (e: Entry, p: EditPatch) => {
    const before = e;
    upsert({ ...e, food_name: p.name, amount: p.amount, unit: p.unit, servings: p.servings, cost: p.costPer == null ? null : Math.round(p.costPer * p.servings * 100) / 100,
      ...previewAfter({ nutrition: e.nutrition, servings: e.servings, amount: e.amount, source: e.nutrition_source, ref: e.nutrition_ref }, p) });
    try {
      const r = await api.put<{ item: Entry; saved_food_id: string | null }>(`/health/meals/entries/${e.id}`, { food_name: p.name, amount: p.amount, unit: p.unit, servings: p.servings, cost: p.costPer, save_as_food: p.saveAsFood, ...nutritionBody(p) });
      upsert(r.item);
      if (r.saved_food_id) { refreshLibrary(); toast(`「${p.name}」をよく食べるものに登録しました`, "success"); }
      if (p.relookup) resolve("entry", e.id, { quiet: true });
    } catch (err) { upsert(before); toast(errText(err, "保存できませんでした"), "error"); }
  }, [refreshLibrary, resolve, toast, upsert]);

  /** Delete with a short undo window; the request goes out when the window closes. */
  const commitDelete = useCallback(async (entry: Entry) => {
    try { await api.del(`/health/meals/entries/${entry.id}`); drop(entry.id); }
    catch (e) { toast(errText(e, "削除できませんでした"), "error"); }
    finally { setHidden((h) => { const n = new Set(h); n.delete(entry.id); return n; }); }
  }, [drop, toast]);
  const removeEntry = useCallback((entry: Entry) => {
    const prev = undoRef.current; if (prev) { clearTimeout(prev.timer); commitDelete(prev.entry); }
    setHidden((h) => new Set(h).add(entry.id));
    const timer = setTimeout(() => { setUndo((u) => (u?.entry.id === entry.id ? null : u)); commitDelete(entry); }, 5000);
    setUndo({ entry, timer });
  }, [commitDelete]);
  const undoDelete = useCallback(() => {
    const u = undoRef.current; if (!u) return;
    clearTimeout(u.timer); setUndo(null);
    setHidden((h) => { const n = new Set(h); n.delete(u.entry.id); return n; });
  }, []);
  /** Leaving the day (or the tab) sends a pending delete right away. */
  const flush = useCallback(() => { const u = undoRef.current; if (u) { clearTimeout(u.timer); setUndo(null); commitDelete(u.entry); } }, [commitDelete]);

  const clearDay = useCallback(async () => {
    const snapshot = d.data;
    patch((p) => ({ ...p, entries: [] }));
    try { await api.del(`/health/meals/day/${dayRef.current}`); }
    catch (e) { if (snapshot) d.setData(snapshot); toast(errText(e, "削除できませんでした"), "error"); }
  }, [d, patch, toast]);

  const saveTargets = useCallback(async (t: Nutrition) => {
    const before = d.data?.summary.targets ?? {};
    patch((p) => ({ ...p, summary: { ...p.summary, targets: t } }));
    try { const r = await api.put<{ targets: Nutrition }>("/health/targets", t); patch((p) => ({ ...p, summary: { ...p.summary, targets: r.targets } })); toast("目標を保存しました", "success"); }
    catch (e) { patch((p) => ({ ...p, summary: { ...p.summary, targets: before } })); toast(errText(e, "保存できませんでした"), "error"); }
  }, [d.data, patch, toast]);

  const entries = useMemo(() => (d.data?.entries ?? []).filter((e) => !hidden.has(e.id)), [d.data?.entries, hidden]);
  const sum = useMemo(() => summarize(entries), [entries]);
  return { d, entries, sum, lookups, undo, keyOf, resolve, addFood, addText, addSet, editEntry, removeEntry, undoDelete, flush, clearDay, saveTargets, refreshLibrary, patch, upsert, setLookup, isTemp };
}

/** Entry → editable shape for the sheet. */
export const entryEditable = (e: Entry): Editable => ({
  id: e.id, kind: "entry", name: e.food_name, amount: e.amount, unit: e.unit, servings: e.servings,
  costPer: e.cost == null ? null : Math.round((e.cost / (e.servings || 1)) * 100) / 100, nutrition: perServing(e), source: e.nutrition_source, ref: e.nutrition_ref, savedFood: Boolean(e.food_id),
});
