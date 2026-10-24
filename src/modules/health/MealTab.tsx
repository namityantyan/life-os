/**
 * 食事: a log of what was actually eaten each day (JST). Type "ゆで卵 2個" or tap a saved food / set;
 * the row appears at once and its nutrition fills in from the 日本食品標準成分表 in the background.
 * Tapping a row opens one focused sheet to correct the food, grams, servings, cost or values.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { Button, Card, ChatPanel, EmptyState, ErrorBanner, IconButton, Input, Skeleton, cx, useToast } from "@/components/ui";
import { api, useApi, todayJst } from "@/lib/api";
import type { ChatItem } from "./shared";
import { DaySummary, WeekStrip } from "./meal/Summary";
import { QuickAdd } from "./meal/QuickAdd";
import { EntryList } from "./meal/EntryList";
import { ItemSheet, type EditPatch, type Editable } from "./meal/ItemSheet";
import { LibrarySheet } from "./meal/Library";
import { TargetsSheet } from "./meal/Targets";
import { ProposalCard, type ApplyRes } from "./meal/Proposal";
import { Sheet } from "./meal/Sheet";
import { entryEditable, nutritionBody, useMealLog } from "./meal/store";
import { TABLE_CREDIT, dayName, mdLabel, shiftDay, type DayTotal, type Entry, type Food, type MealSet, type SetItem } from "./meal/model";

/* ---------------------------------------------------------------- chat */
function useMealChat() {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { let alive = true; api.get<{ items: ChatItem[] }>("/health/chat/meal").then((r) => alive && setMessages(r.items)).catch(() => {}); return () => { alive = false; }; }, []);
  const send = useCallback(async (text: string) => {
    setMessages((m) => [...m, { role: "user", content: text }]); setBusy(true);
    try { const r = await api.post<{ reply: string; provider: string; proposal: unknown; id: string }>("/health/chat/meal", { message: text }); setMessages((m) => [...m, { id: r.id, role: "assistant", content: r.reply, provider: r.provider, proposal: r.proposal }]); }
    catch (e: any) { toast(e?.message ?? "送信できませんでした", "error"); }
    finally { setBusy(false); }
  }, [toast]);
  const markApplied = useCallback((id: string, applied: Record<string, unknown>) => setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, applied } : m))), []);
  return { messages, busy, send, markApplied };
}
const useWide = () => {
  const q = "(min-width: 1024px)";
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const h = () => setWide(m.matches); m.addEventListener("change", h); return () => m.removeEventListener("change", h); }, []);
  return wide;
};

type Editing = { kind: "entry"; entry: Entry } | { kind: "food"; food: Food } | { kind: "item"; item: SetItem } | null;

/* ---------------------------------------------------------------- page */
export function MealTab() {
  const toast = useToast();
  const today = todayJst();
  const [day, setDay] = useState(today);
  const log = useMealLog(day);
  const { d, entries, sum, lookups } = log;
  const weekEnd = day >= shiftDay(today, -6) ? today : shiftDay(day, 3) > today ? today : shiftDay(day, 3);
  const week = useApi<{ items: DayTotal[] }>(`/health/meals/days?to=${weekEnd}&n=7`, { quiet: true });
  const chat = useMealChat();
  const wide = useWide();
  const [editing, setEditing] = useState<Editing>(null);
  const [library, setLibrary] = useState(false);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [setFromDay, setSetFromDay] = useState(false);

  const go = (next: string) => { log.flush(); setDay(next > today ? today : next); };
  const data = d.data; const ready = data?.day === day;
  const foods = data?.foods ?? [], sets = data?.sets ?? [], targets = data?.summary?.targets ?? {};
  const weekDays = useMemo(() => (week.data?.items ?? []).map((w) => (w.day === day && ready ? { day: w.day, kcal: sum.nutrition.totals.energy_kcal, count: entries.length } : { day: w.day, kcal: w.nutrition.totals.energy_kcal, count: w.count })), [week.data, day, ready, sum, entries.length]);
  const label = dayName(day);

  // live copies for the sheet, so a background lookup that finishes shows up in it
  const editable: Editable | null = useMemo(() => {
    if (!editing) return null;
    if (editing.kind === "entry") { const e = entries.find((x) => x.id === editing.entry.id); return e ? entryEditable(e) : null; }
    if (editing.kind === "food") { const f = foods.find((x) => x.id === editing.food.id) ?? editing.food; return { id: f.id, kind: "food", name: f.name, amount: f.amount, unit: f.unit, servings: 1, costPer: f.cost_per_serving, nutrition: f.nutrition, source: f.nutrition_source, ref: f.nutrition_ref }; }
    const m = sets.flatMap((s) => s.items).find((x) => x.id === editing.item.id) ?? editing.item;
    return { id: m.id, kind: "item", name: m.food_name, amount: m.amount, unit: m.unit, servings: 1, costPer: m.cost_per_serving, nutrition: m.nutrition, source: m.nutrition_source, ref: m.nutrition_ref };
  }, [editing, entries, foods, sets]);

  const saveEdit = async (p: EditPatch) => {
    const cur = editing; setEditing(null); if (!cur) return;
    if (cur.kind === "entry") return log.editEntry(cur.entry, p);
    const body = { name: p.name, amount: p.amount, unit: p.unit, cost_per_serving: p.costPer, ...nutritionBody(p) };
    try {
      if (cur.kind === "food") {
        const r = await api.put<{ item: Food }>(`/health/meals/foods/${cur.food.id}`, body);
        log.patch((x) => ({ ...x, foods: x.foods.map((f) => (f.id === r.item.id ? r.item : f)) }));
        if (p.relookup) log.resolve("food", r.item.id, { quiet: true });
      } else {
        const r = await api.put<{ item: SetItem }>(`/health/meals/sets/${cur.item.set_id}/items/${cur.item.id}`, body);
        log.patch((x) => ({ ...x, sets: x.sets.map((s) => (s.id === cur.item.set_id ? { ...s, items: s.items.map((m) => (m.id === r.item.id ? r.item : m)) } : s)) }));
        log.refreshLibrary();
        if (p.relookup) log.resolve("item", r.item.id, { quiet: true });
      }
      toast("保存しました", "success");
    } catch (e: any) { toast(e?.message ?? "保存できませんでした", "error"); }
  };
  const deleteEditing = () => {
    const cur = editing; setEditing(null); if (!cur) return;
    if (cur.kind === "entry") return log.removeEntry(cur.entry);
    if (cur.kind === "food") {
      if (!confirm(`「${cur.food.name}」を一覧から削除しますか？（過去の記録は残ります）`)) return;
      log.patch((x) => ({ ...x, foods: x.foods.filter((f) => f.id !== cur.food.id) }));
      api.del(`/health/meals/foods/${cur.food.id}`).catch((e) => { toast(e?.message ?? "削除できませんでした", "error"); log.refreshLibrary(); });
    } else {
      log.patch((x) => ({ ...x, sets: x.sets.map((s) => (s.id === cur.item.set_id ? { ...s, items: s.items.filter((m) => m.id !== cur.item.id) } : s)) }));
      api.del(`/health/meals/sets/${cur.item.set_id}/items/${cur.item.id}`).then(() => log.refreshLibrary()).catch((e) => { toast(e?.message ?? "外せませんでした", "error"); log.refreshLibrary(); });
    }
  };
  const onApplied = (res: ApplyRes, applied: Record<string, unknown>, id: string) => {
    chat.markApplied(id, applied);
    if (res.day === day) log.patch((x) => ({ ...x, entries: [...res.entries, ...x.entries.filter((e) => e.id.startsWith("tmp-"))], summary: { ...x.summary, targets: res.summary.targets } }));
    else log.patch((x) => ({ ...x, summary: { ...x.summary, targets: res.summary.targets } }));
    if (res.added) log.refreshLibrary();
    for (const pid of res.pending_ids ?? []) log.resolve("entry", pid, { quiet: true });
  };

  const chatPanel = (h: string) => (
    <ChatPanel messages={chat.messages} onSend={chat.send} busy={chat.busy} height={h}
      placeholder="例: ゆで卵2個を食べた / たんぱく質の目標を120gに"
      emptyHint="今日の記録と目標をもとに相談できます。記録の追加・変更や目標の変更を頼むと、反映できる変更が下に出ます。"
      renderExtra={(m) => { const it = m as ChatItem; return it.proposal ? <ProposalCard item={it} entries={day === today ? entries : []} targets={targets} onApplied={(r, a) => onApplied(r, a, it.id!)} /> : null; }} />
  );

  if (!data && d.loading) return <MealSkeleton />;
  if (!data?.summary) return <div><ErrorBanner message={d.error} onRetry={() => d.reload()} testId="health-error" /><EmptyState title="食事を読み込めませんでした" /></div>;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem] items-start">
      <div className="space-y-4 min-w-0">
        {/* day navigation + the last 7 days */}
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <IconButton label="前の日" onClick={() => go(shiftDay(day, -1))} data-testid="day-prev"><Icon name="chevron-left" /></IconButton>
            <h2 className="flex-1 min-w-0 text-center sm:text-left sm:flex-none sm:px-1 font-semibold tracking-tight text-lg" data-testid="day-label" aria-live="polite">
              {label ?? mdLabel(day)}{label && <span className="text-label-2 font-normal text-sm ml-2">{mdLabel(day)}</span>}
            </h2>
            <IconButton label="次の日" onClick={() => go(shiftDay(day, 1))} data-testid="day-next" disabled={day >= today}><Icon name="chevron-right" /></IconButton>
            <span className="hidden sm:block flex-1" />
            {day !== today && <Button size="sm" variant="ghost" onClick={() => go(today)}>今日へ</Button>}
          </div>
          {weekDays.length > 0 && <WeekStrip days={weekDays} selected={day} target={targets.energy_kcal ?? null} onPick={go} />}
        </div>

        {d.error && <ErrorBanner message={d.error} onRetry={() => d.reload()} className="mb-0" />}
        <DaySummary sum={sum} targets={targets} onTargets={() => setTargetsOpen(true)} loading={!ready} />
        <QuickAdd foods={foods} sets={sets} dayLabel={label ?? mdLabel(day)} onText={(t) => log.addText(t, foods)} onFood={(f) => log.addFood(f)} onSet={(s: MealSet) => log.addSet(s)} onManage={() => setLibrary(true)} />

        <section className="space-y-2" aria-label="記録">
          <div className="flex items-center justify-between gap-2 px-1">
            <h3 className="font-semibold tracking-tight">記録<span className="text-label-2 font-normal text-sm ml-1.5 tabular">{ready ? `${entries.length}件` : ""}</span></h3>
            {ready && entries.length > 0 && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => setSetFromDay(true)} data-testid="day-to-set">セットとして保存</Button>
                <Button size="sm" variant="ghost" className="text-red" onClick={() => { if (confirm(`${label ?? mdLabel(day)}の記録をすべて削除しますか？`)) log.clearDay(); }} data-testid="day-clear">すべて削除</Button>
              </div>
            )}
          </div>
          {ready ? (
            <EntryList entries={entries} lookups={lookups} keyOf={log.keyOf} onOpen={(e) => setEditing({ kind: "entry", entry: e })} onDelete={log.removeEntry}
              empty={<EmptyState title={`${label ?? mdLabel(day)}の記録はまだありません`} hint="上の欄に「ごはん 150g」のように入れるか、よく食べるもの・セットをタップして追加します。" />} />
          ) : <Card padded={false} className="p-3 space-y-2" aria-busy="true"><Skeleton className="h-12" /><Skeleton className="h-12" /></Card>}
          <p className="text-[0.6875rem] text-label-3 px-1">{TABLE_CREDIT}</p>
        </section>

        {!wide && (
          <Card onClick={() => setChatOpen(true)} className="flex items-center gap-3" data-testid="meal-chat-open">
            <span className="size-10 rounded-full bg-accent-soft text-accent grid place-items-center shrink-0"><Icon name="assistant" size={20} /></span>
            <span className="flex-1 min-w-0"><span className="block font-medium">管理栄養士に相談</span><span className="block text-sm text-label-2 truncate">{[...chat.messages].reverse().find((m) => m.role === "assistant")?.content ?? "記録の追加や目標の変更も頼めます"}</span></span>
            <Icon name="chevron-right" size={18} className="text-label-3" />
          </Card>
        )}
      </div>

      {wide && (
        <Card as="section" className="flex flex-col lg:sticky lg:top-20 self-start w-full">
          <h2 className="text-lg font-semibold tracking-tight mb-2">管理栄養士に相談</h2>
          {chatPanel("min(70dvh, 36rem)")}
        </Card>
      )}
      {!wide && <Sheet open={chatOpen} onClose={() => setChatOpen(false)} title="管理栄養士に相談" testId="meal-chat-sheet">{chatPanel("min(72dvh, 40rem)")}</Sheet>}

      <ItemSheet item={editable} onClose={() => setEditing(null)} onSave={saveEdit} onDelete={deleteEditing} lookup={editable ? lookups[editable.id] : undefined} />
      <LibrarySheet open={library} onClose={() => setLibrary(false)} foods={foods} sets={sets} patch={log.patch} resolve={log.resolve} lookups={lookups}
        onEditFood={(f) => setEditing({ kind: "food", food: f })} onEditItem={(m) => setEditing({ kind: "item", item: m })} />
      <TargetsSheet open={targetsOpen} targets={targets} onClose={() => setTargetsOpen(false)} onSave={(t) => { setTargetsOpen(false); log.saveTargets(t); }} />
      <SetFromDaySheet open={setFromDay} onClose={() => setSetFromDay(false)} entries={entries} onCreated={(s) => { log.patch((x) => ({ ...x, sets: [...x.sets, s] })); toast(`セット「${s.name}」を作りました`, "success"); }} />

      {log.undo && (
        <div className="fixed z-[55] left-1/2 -translate-x-1/2 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] md:bottom-6 popover flex items-center gap-3 pl-4 pr-2 py-1.5 text-sm" role="status" data-testid="undo-bar">
          <span className="max-w-[14rem] truncate">「{log.undo.entry.food_name}」を削除しました</span>
          <Button size="sm" variant="ghost" onClick={log.undoDelete} data-testid="undo-delete">元に戻す</Button>
        </div>
      )}
    </div>
  );
}

function SetFromDaySheet({ open, onClose, entries, onCreated }: { open: boolean; onClose: () => void; entries: Entry[]; onCreated: (s: MealSet) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const real = entries.filter((e) => !e.id.startsWith("tmp-"));
  const submit = async () => {
    const n = name.trim(); if (!n) return;
    setBusy(true);
    try { const r = await api.post<{ item: MealSet }>("/health/meals/sets", { name: n, entry_ids: real.map((e) => e.id) }); onCreated(r.item); setName(""); onClose(); }
    catch (e: any) { toast(e?.message ?? "作成できませんでした", "error"); } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title="この日の記録をセットにする">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="セットの名前（例: いつもの朝食）" aria-label="セットの名前" data-autofocus data-testid="day-to-set-name" />
        <ul className="text-sm text-label-2 space-y-0.5">{real.map((e) => <li key={e.id} className="truncate">{e.food_name}</li>)}</ul>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>キャンセル</Button><Button type="submit" variant="primary" loading={busy} disabled={!name.trim()} data-testid="day-to-set-save">セットを作成</Button></div>
      </form>
    </Sheet>
  );
}

function MealSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]" aria-busy="true" aria-label="読み込み中" data-testid="page-skeleton">
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" /><Skeleton className="h-16 w-full" />
        <div className="card p-5 flex gap-5"><Skeleton className="size-[7.5rem] rounded-full" /><div className="flex-1 space-y-4 pt-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-full" /></div></div>
        <div className="card p-5 space-y-3"><Skeleton className="h-12 w-full" /><div className="flex gap-2"><Skeleton className="h-9 w-24" /><Skeleton className="h-9 w-20" /><Skeleton className="h-9 w-28" /></div></div>
        <div className="card p-3 space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
      </div>
      <div className={cx("hidden lg:block card p-5")}><Skeleton className="h-96 w-full" /></div>
    </div>
  );
}
