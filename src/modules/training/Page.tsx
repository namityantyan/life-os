import { Icon } from "@/components/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Routes, Route, useNavigate, useLocation, useParams } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { PageHeader, Card, Section, Button, Badge, Input, Select, Field, Segmented, EmptyState, ErrorBanner, PageSkeleton, Stagger, Item, IconButton, Modal, Table, Th, Td, trCls, useToast, cx } from "@/components/ui";
import { api, useApi, fmtDate, fmtDateTime, fmtNum } from "@/lib/api";
import {
  CATALOG, PARTS, EQUIPMENTS, EQUIPMENT_LABELS, UNIT_LABELS, getExercise, legacyKeysFor, searchCatalog, sortByUsage, lastDoneLabel, unitFor,
  type TrainingUsage, type UsageStat, type CatalogEntry, type Part, type Equipment, type TrainingSession, type TrainingSet, type ExerciseRecord, type WeightUnit,
} from "@shared/training";

type Tab = "log" | "history" | "catalog" | "records";
const TAB_PATH: Record<Tab, string> = { log: "/training", history: "/training/history", catalog: "/training/catalog", records: "/training/records" };
const tabFromPath = (p: string): Tab => (p.startsWith("/training/history") ? "history" : p.startsWith("/training/catalog") ? "catalog" : p.startsWith("/training/records") ? "records" : "log");

type Active = { session: TrainingSession | null; sets: TrainingSet[] };
type AdviceRes = { entry: CatalogEntry; advice: { kind: string; weight: number | null; target_reps: number | null; target_sec?: number | null; message: string } };

const fmtWeight = (w: number | null | undefined) => (w == null ? "—" : `${fmtNum(w, Number.isInteger(w) ? 0 : 1)}kg`);
const describeSet = (s: TrainingSet) => {
  if (s.unit === "time") return `${s.duration_sec ?? "—"}秒`;
  if (s.unit === "bodyweight") return `${s.reps ?? "—"}回`;
  return `${fmtWeight(s.weight)} × ${s.reps ?? "—"}`;
};
const elapsedLabel = (iso: string) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60}分`; };

/** Small "前回" badge: 今日 / 昨日 / 3日前 … */
function LastDone({ u, className }: { u: UsageStat | undefined; className?: string }) {
  if (!u) return null;
  return <span className={cx("text-[0.6875rem] leading-none font-normal tabular opacity-70", className)} data-testid="last-done">{lastDoneLabel(u.last)}</span>;
}

export default function Page() {
  const nav = useNavigate();
  const loc = useLocation();
  const tab = tabFromPath(loc.pathname);
  return (
    <div>
      <PageHeader title="トレーニング" subtitle="記録・履歴・種目・重量と推定1RM"
        actions={<Segmented<Tab> value={tab} onChange={(t) => nav(TAB_PATH[t])} options={[{ value: "log", label: <span data-testid="tab-log">記録</span> }, { value: "history", label: <span data-testid="tab-history">履歴</span> }, { value: "catalog", label: <span data-testid="tab-catalog">種目</span> }, { value: "records", label: <span data-testid="tab-records">重量・1RM</span> }]} />} />
      <Routes>
        <Route path="/" element={<LogTab />} />
        <Route path="/history" element={<HistoryTab />} />
        <Route path="/history/:id" element={<SessionDetail />} />
        <Route path="/catalog" element={<CatalogTab />} />
        <Route path="/records" element={<RecordsTab />} />
        <Route path="/exercises/:key" element={<ExerciseHistory />} />
        <Route path="*" element={<LogTab />} />
      </Routes>
    </div>
  );
}

/* ====================== 記録 ====================== */
function LogTab() {
  const { data, loading, error, reload, setData } = useApi<Active>("/training/active");
  const { data: usage } = useApi<TrainingUsage>("/training/usage");
  const toast = useToast();
  const nav = useNavigate();
  const [starting, setStarting] = useState<Part | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const start = async (part: Part) => {
    setStarting(part);
    try { await api.post("/training/sessions", { part }); await reload(true); }
    catch (e: any) { toast(e?.message ?? "開始できませんでした", "error"); }
    finally { setStarting(null); }
  };
  const finish = async () => {
    if (!data?.session) return;
    setFinishing(true);
    try {
      const r = await api.post<{ session: TrainingSession }>(`/training/sessions/${data.session.id}/finish`);
      toast("トレーニングを終了しました", "success");
      setData({ session: null, sets: [] });
      setFinishOpen(false);
      nav(`/training/history/${r.session.id}`);
    } catch (e: any) { toast(e?.message ?? "終了できませんでした", "error"); }
    finally { setFinishing(false); }
  };

  if (loading && !data) return <PageSkeleton cards={3} />;
  if (!data) return <div><ErrorBanner message={error} onRetry={() => reload()} testId="training-error" /><EmptyState title="記録を読み込めませんでした" /></div>;
  const session = data.session;

  if (!session) {
    return (
      <Section title="セッションを開始">
        <Card>
          <p className="text-sm text-label-2 mb-4">今日鍛える部位を選ぶと記録が始まります。</p>
          <Stagger className="flex flex-wrap gap-2">
            {sortByUsage([...PARTS], (p) => p, usage?.parts).map((p) => (
              <Item key={p} layout={false}>
                <Button variant="tinted" size="lg" loading={starting === p} disabled={Boolean(starting)} onClick={() => start(p)} data-testid={`part-chip-${p}`}>{p}<LastDone u={usage?.parts[p]} className="ml-1" /></Button>
              </Item>
            ))}
          </Stagger>
        </Card>
      </Section>
    );
  }
  return (
    <>
      <ActiveSession session={session} sets={data.sets} usage={usage} onChange={(sets) => setData({ session, sets })} onFinish={() => setFinishOpen(true)} />
      <Modal open={finishOpen} onClose={() => setFinishOpen(false)} title="トレーニングを終了"
        footer={<><Button onClick={() => setFinishOpen(false)}>戻る</Button><Button variant="primary" loading={finishing} onClick={finish} data-testid="finish-confirm">終了する</Button></>}>
        <p className="text-sm text-label-2">{session.part}・{data.sets.length}セットを記録しました。終了すると履歴に保存され、通知にまとめが届きます。</p>
      </Modal>
    </>
  );
}

function ActiveSession({ session, sets, usage, onChange, onFinish }: { session: TrainingSession; sets: TrainingSet[]; usage: TrainingUsage | null; onChange: (sets: TrainingSet[]) => void; onFinish: () => void }) {
  const toast = useToast();
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [restSec, setRestSec] = useState<60 | 90 | 120>(() => { try { return (Number(localStorage.getItem("training:rest")) as 60 | 90 | 120) || 90; } catch { return 90; } });
  const [restStartedAt, setRestStartedAt] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(id); }, []);

  const recentKeys = useMemo(() => { const ks: string[] = []; for (const s of [...sets].reverse()) if (!ks.includes(s.exercise_key)) ks.push(s.exercise_key); return ks; }, [sets]);
  const grouped = useMemo(() => { const g = new Map<string, TrainingSet[]>(); for (const s of sets) { const a = g.get(s.exercise_key) ?? []; a.push(s); g.set(s.exercise_key, a); } return [...g.entries()]; }, [sets]);

  const addSet = async (body: { exercise_key: string; weight: number | null; reps: number | null; duration_sec: number | null; unit: WeightUnit; memo: string | null }) => {
    const r = await api.post<{ set: TrainingSet }>(`/training/sessions/${session.id}/sets`, body);
    onChange([...sets, r.set]);
    setRestStartedAt(Date.now());
  };
  const delSet = async (id: string) => {
    try { await api.del(`/training/sets/${id}`); onChange(sets.filter((s) => s.id !== id)); }
    catch (e: any) { toast(e?.message ?? "削除できませんでした", "error"); }
  };
  const chooseRest = (v: 60 | 90 | 120) => { setRestSec(v); try { localStorage.setItem("training:rest", String(v)); } catch { /* ignore */ } };

  return (
    <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-5 min-w-0">
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2"><Badge tone="accent">進行中</Badge><span className="text-xl font-semibold tracking-tight" data-testid="active-part">{session.part}</span></div>
              <div className="text-xs text-label-2 mt-1 tabular">{fmtDateTime(session.started_at)} 開始 ・ {elapsedLabel(session.started_at)} ・ {sets.length}セット</div>
            </div>
            <Button variant="primary" onClick={onFinish} data-testid="finish-session">終了</Button>
          </div>
        </Card>

        <Section title="種目">
          <ExercisePicker selected={selected} onSelect={setSelected} recentKeys={recentKeys} part={session.part as Part} usage={usage?.exercises} />
        </Section>

        <AnimatePresence initial={false}>
          {selected && (
            <motion.div key={selected.key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.14 }}>
              <SetForm entry={selected} lastSet={[...sets].reverse().find((s) => s.exercise_key === selected.key) ?? null} onSubmit={addSet} />
            </motion.div>
          )}
        </AnimatePresence>

        <Section title="今日のセット">
          {sets.length === 0 ? <EmptyState title="まだセットがありません" hint="種目を選んで重量と回数を記録します。" /> : (
            <div className="space-y-3">
              {grouped.map(([key, arr]) => (
                <Card key={key} padded={false} className="overflow-hidden">
                  <div className="px-5 pt-4 pb-2 flex items-center justify-between">
                    <button type="button" className="focus-ring rounded-[var(--radius-sm)] font-semibold tracking-tight text-left hover:text-accent" onClick={() => setSelected(getExercise(key) ?? null)}>{getExercise(key)?.name ?? key}</button>
                    <span className="text-xs text-label-2">{arr.length}セット</span>
                  </div>
                  <AnimatePresence initial={false}>
                    {arr.map((s, i) => (
                      <motion.div key={s.id} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden" data-testid="set-row">
                        <div className="flex items-center gap-3 px-5 py-2.5 border-t border-separator">
                          <span className="text-xs text-label-3 w-5 tabular">{i + 1}</span>
                          <span className="font-medium tabular">{describeSet(s)}</span>
                          {s.memo && <span className="text-xs text-label-2 truncate">{s.memo}</span>}
                          <span className="ml-auto text-xs text-label-3 tabular">{fmtDateTime(s.created_at).split(" ")[1]}</span>
                          <IconButton label={`セット${i + 1}（${describeSet(s)}）を削除`} className="hover:text-red" onClick={() => delSet(s.id)}><Icon name="delete" size={18} /></IconButton>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </Card>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="space-y-5">
        <RestTimer seconds={restSec} startedAt={restStartedAt} onChoose={chooseRest} onStop={() => setRestStartedAt(null)} />
      </div>
    </div>
  );
}

function ExercisePicker({ selected, onSelect, recentKeys, part, usage }: { selected: CatalogEntry | null; onSelect: (e: CatalogEntry) => void; recentKeys: string[]; part: Part; usage?: Record<string, UsageStat> }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  // Without a query: this part's exercises, most used first. With a query: search rank first, usage breaks ties inside a rank.
  const results = useMemo(() => (q.trim() ? searchCatalog(q).slice(0, 12) : sortByUsage(searchCatalog("", { part }), (e) => e.key, usage).slice(0, 12)), [q, part, usage]);
  // Chips: this part's most used exercises (stable order while recording), plus anything done today outside that list.
  const chipKeys = useMemo(() => {
    const frequent = sortByUsage(searchCatalog("", { part }).filter((e) => usage?.[e.key]), (e) => e.key, usage).slice(0, 8).map((e) => e.key);
    return [...frequent, ...recentKeys.filter((k) => !frequent.includes(k))];
  }, [part, usage, recentKeys]);
  const doneToday = (k: string) => recentKeys.includes(k);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; window.addEventListener("mousedown", h); return () => window.removeEventListener("mousedown", h); }, []);
  const pick = (e: CatalogEntry) => { onSelect(e); setQ(""); setOpen(false); };
  return (
    <Card className="space-y-3">
      {chipKeys.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="exercise-chips">
          {chipKeys.map((k) => { const e = getExercise(k); if (!e) return null; return (
            <button key={k} type="button" aria-pressed={selected?.key === k} onClick={() => pick(e)} data-testid={`exercise-chip-${k}`}
              className={cx("pressable focus-ring rounded-full px-3 h-8 text-sm font-medium inline-flex items-center gap-1.5", selected?.key === k ? "bg-accent text-white" : "bg-fill text-label hover:bg-fill-strong")}>
              {doneToday(k) && <Icon name="check" size={16} strokeWidth={2.25} title="今日記録済み" />}{e.name}{!doneToday(k) && <LastDone u={usage?.[k]} />}
            </button>
          ); })}
        </div>
      )}
      <div ref={ref} className="relative">
        <Input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder={selected ? `${selected.name}（別の種目を検索）` : "種目を検索（名前・別名・部位・器具）"} aria-label="種目を検索" data-testid="exercise-search" />
        <AnimatePresence>
          {open && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }} className="absolute z-20 left-0 right-0 mt-2 bg-elevated rounded-[var(--radius-lg)] shadow-[var(--shadow-pop)] overflow-hidden max-h-80 overflow-y-auto" data-testid="exercise-results">
              {results.length === 0 && <div className="px-4 py-3 text-sm text-label-2">該当する種目がありません</div>}
              {results.map((e) => (
                <button key={e.key} type="button" onClick={() => pick(e)} className="focus-ring w-full text-left px-4 py-2.5 hover:bg-fill flex items-center gap-3" data-testid={`exercise-option-${e.key}`}>
                  <span className="font-medium">{e.name}</span>
                  <span className="text-xs text-label-2">{e.part} ・ {EQUIPMENT_LABELS[e.equipment]}</span>
                  <span className="ml-auto flex items-center gap-2 text-xs text-label-3">{usage?.[e.key] && <Badge>{lastDoneLabel(usage[e.key].last)}</Badge>}{UNIT_LABELS[unitFor(e)]}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Card>
  );
}

function SetForm({ entry, lastSet, onSubmit }: { entry: CatalogEntry; lastSet: TrainingSet | null; onSubmit: (b: { exercise_key: string; weight: number | null; reps: number | null; duration_sec: number | null; unit: WeightUnit; memo: string | null }) => Promise<void> }) {
  const toast = useToast();
  const unit = unitFor(entry);
  const isTime = unit === "time", isBw = unit === "bodyweight";
  const [weight, setWeight] = useState("");
  const [reps, setReps] = useState("");
  const [sec, setSec] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: adv } = useApi<AdviceRes>(`/training/advice/${entry.key}`);
  // Prefill from the last set of this exercise (or the advice) only while the user has not typed anything.
  const dirty = useRef(false);
  useEffect(() => { dirty.current = false; }, [entry.key]);
  useEffect(() => {
    if (dirty.current) return;
    if (lastSet) { setWeight(lastSet.weight != null ? String(lastSet.weight) : ""); setReps(lastSet.reps != null ? String(lastSet.reps) : ""); setSec(lastSet.duration_sec != null ? String(lastSet.duration_sec) : ""); }
    else if (adv?.advice) { setWeight(adv.advice.weight != null ? String(adv.advice.weight) : ""); setReps(adv.advice.target_reps != null ? String(adv.advice.target_reps) : ""); setSec(adv.advice.target_sec != null ? String(adv.advice.target_sec) : ""); }
    setMemo("");
  }, [entry.key, adv, lastSet]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const w = weight.trim() === "" ? null : Number(weight), r = reps.trim() === "" ? null : Number(reps), s = sec.trim() === "" ? null : Number(sec);
    if (isTime ? s == null || !(s > 0) : r == null || !(r > 0)) { toast(isTime ? "秒数を入力してください" : "回数を入力してください", "error"); return; }
    if (!isTime && !isBw && (w == null || !(w > 0))) { toast("重量を入力してください", "error"); return; }
    setBusy(true);
    try { await onSubmit({ exercise_key: entry.key, weight: isTime || isBw ? null : w, reps: isTime ? null : r, duration_sec: isTime ? s : null, unit, memo: memo.trim() || null }); setMemo(""); dirty.current = false; }
    catch (err: any) { toast(err?.message ?? "記録できませんでした", "error"); }
    finally { setBusy(false); }
  };
  const unitHint = isTime ? "保持時間を秒で記録" : isBw ? "自重：回数のみ" : unit === "per_hand" ? "ダンベルは片手の重量" : unit === "plate" ? "スミス：プレート重量のまま" : "合計重量";
  return (
    <Card as="section">
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div><span className="text-lg font-semibold tracking-tight" data-testid="selected-exercise">{entry.name}</span><span className="text-xs text-label-2 ml-2">{entry.part} ・ {EQUIPMENT_LABELS[entry.equipment]}</span></div>
          <Badge tone="neutral">{UNIT_LABELS[unit]}</Badge>
        </div>
        {adv?.advice && <p className="text-sm text-label-2" data-testid="advice">{adv.advice.message}</p>}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {!isTime && !isBw && <Field label="重量 (kg)" hint={unitHint}><Input inputMode="decimal" type="number" step="0.5" min="0" value={weight} onChange={(e) => { dirty.current = true; setWeight(e.target.value); }} data-testid="set-weight" /></Field>}
          {!isTime && <Field label="回数" hint={isBw ? unitHint : `目安 ${entry.rep_min}〜${entry.rep_max}回`}><Input inputMode="numeric" type="number" step="1" min="0" value={reps} onChange={(e) => { dirty.current = true; setReps(e.target.value); }} data-testid="set-reps" /></Field>}
          {isTime && <Field label="秒数" hint={unitHint}><Input inputMode="numeric" type="number" step="5" min="0" value={sec} onChange={(e) => { dirty.current = true; setSec(e.target.value); }} data-testid="set-seconds" /></Field>}
          <Field label="メモ" className="col-span-2"><Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="任意" data-testid="set-memo" /></Field>
        </div>
        <div className="flex justify-end"><Button type="submit" variant="primary" loading={busy} data-testid="set-submit">セットを記録</Button></div>
      </form>
    </Card>
  );
}

function RestTimer({ seconds, startedAt, onChoose, onStop }: { seconds: 60 | 90 | 120; startedAt: number | null; onChoose: (v: 60 | 90 | 120) => void; onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (startedAt == null) return; setNow(Date.now()); const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id); }, [startedAt]);
  const elapsed = startedAt == null ? 0 : (now - startedAt) / 1000;
  const remain = Math.max(0, seconds - elapsed);
  const done = startedAt != null && remain <= 0;
  const progress = startedAt == null ? 0 : Math.min(1, elapsed / seconds);
  const R = 54, C = 2 * Math.PI * R;
  return (
    <Card as="section" className="flex flex-col items-center gap-4">
      <div className="w-full flex items-center justify-between"><span className="text-sm font-semibold tracking-tight">休憩</span>
        <Segmented<"60" | "90" | "120"> value={String(seconds) as "60" | "90" | "120"} onChange={(v) => onChoose(Number(v) as 60 | 90 | 120)} options={[{ value: "60", label: "60秒" }, { value: "90", label: "90秒" }, { value: "120", label: "120秒" }]} />
      </div>
      <div className="relative size-36" data-testid="rest-timer" data-state={startedAt == null ? "idle" : done ? "done" : "running"}>
        <svg viewBox="0 0 128 128" className="size-full -rotate-90">
          <circle cx="64" cy="64" r={R} fill="none" stroke="var(--fill)" strokeWidth="8" />
          <motion.circle cx="64" cy="64" r={R} fill="none" stroke={done ? "var(--green)" : "var(--accent)"} strokeWidth="8" strokeLinecap="round" strokeDasharray={C}
            animate={{ strokeDashoffset: C * (1 - progress) }} transition={{ duration: 0.25, ease: "linear" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <motion.div key={done ? "done" : "n"} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className={cx("text-3xl font-semibold tabular tracking-tight", done && "text-green")}>
            {startedAt == null ? `${seconds}` : done ? "終了" : Math.ceil(remain)}
          </motion.div>
          <div className="text-xs text-label-2">{startedAt == null ? "記録後に開始" : done ? "次のセットへ" : "秒"}</div>
        </div>
      </div>
      {startedAt != null && <Button size="sm" onClick={onStop}>{done ? "閉じる" : "スキップ"}</Button>}
    </Card>
  );
}

/* ====================== 履歴 ====================== */
function HistoryTab() {
  const { data, loading, error, reload } = useApi<{ items: TrainingSession[] }>("/training/sessions?limit=100");
  const nav = useNavigate();
  if (loading && !data) return <PageSkeleton cards={4} />;
  if (!data) return <div><ErrorBanner message={error} onRetry={() => reload()} testId="training-error" /><EmptyState title="履歴を読み込めませんでした" /></div>;
  const items = data.items;
  if (items.length === 0) return <EmptyState title="履歴がありません" hint="記録タブからセッションを開始すると、ここに並びます。" />;
  return (
    <Section title="セッション">
      <Stagger className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {items.map((s) => (
          <Item key={s.id} className="min-w-0">
            <Card onClick={() => nav(`/training/history/${s.id}`)} className="h-full">
              <div className="flex items-center justify-between" data-testid="session-row" data-session-id={s.id}>
                <div className="flex items-center gap-2"><span className="text-lg font-semibold tracking-tight">{s.part}</span>{!s.ended_at && <Badge tone="accent">進行中</Badge>}</div>
                <span className="text-sm text-label-2 tabular">{fmtDate(s.started_at)}</span>
              </div>
              <div className="text-xs text-label-2 mt-2 tabular">{fmtDateTime(s.started_at)}{s.ended_at ? ` 〜 ${fmtDateTime(s.ended_at).split(" ")[1]}` : ""} ・ {s.set_count ?? 0}セット</div>
            </Card>
          </Item>
        ))}
      </Stagger>
    </Section>
  );
}

function SessionDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, loading, error } = useApi<{ session: TrainingSession; sets: TrainingSet[] }>(id ? `/training/sessions/${id}` : null);
  const [delOpen, setDelOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (loading && !data) return <PageSkeleton cards={2} />;
  if (error || !data) return <EmptyState title="セッションが見つかりません" hint={error ?? undefined} action={<Button onClick={() => nav("/training/history")}>履歴へ戻る</Button>} />;
  const { session, sets } = data;
  const grouped = new Map<string, TrainingSet[]>(); for (const s of sets) { const a = grouped.get(s.exercise_key) ?? []; a.push(s); grouped.set(s.exercise_key, a); }
  const remove = async () => { setDeleting(true); try { await api.del(`/training/sessions/${session.id}`); toast("削除しました"); nav("/training/history"); } catch (e: any) { toast(e?.message ?? "削除できませんでした", "error"); setDeleting(false); } };
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2"><Button variant="ghost" size="sm" onClick={() => nav("/training/history")} className="-ml-2 pl-1.5"><Icon name="chevron-left" size={18} />履歴へ戻る</Button></div>
      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div><div className="flex items-center gap-2"><span className="text-2xl font-semibold tracking-tight" data-testid="detail-part">{session.part}</span>{!session.ended_at && <Badge tone="accent">進行中</Badge>}</div>
            <div className="text-sm text-label-2 mt-1 tabular">{fmtDateTime(session.started_at)}{session.ended_at ? ` 〜 ${fmtDateTime(session.ended_at).split(" ")[1]}` : ""} ・ {sets.length}セット</div></div>
          <Button variant="danger" size="sm" onClick={() => setDelOpen(true)}>削除</Button>
        </div>
      </Card>
      {sets.length === 0 ? <EmptyState title="セットがありません" /> : (
        <Stagger className="space-y-3">
          {[...grouped.entries()].map(([key, arr]) => (
            <Item key={key}>
              <Card padded={false}>
                <div className="px-5 pt-4 pb-2 flex items-center justify-between">
                  <button type="button" className="focus-ring rounded-[var(--radius-sm)] font-semibold tracking-tight hover:text-accent text-left" onClick={() => nav(`/training/exercises/${key}`)} aria-label={`${getExercise(key)?.name ?? key}の履歴を開く`} data-testid="detail-exercise">{getExercise(key)?.name ?? key}</button>
                  <span className="text-xs text-label-2">{arr.length}セット</span>
                </div>
                {arr.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-3 px-5 py-2.5 border-t border-separator" data-testid="detail-set">
                    <span className="text-xs text-label-3 w-5 tabular">{i + 1}</span><span className="font-medium tabular">{describeSet(s)}</span>
                    {s.memo && <span className="text-xs text-label-2 truncate">{s.memo}</span>}
                    <span className="ml-auto text-xs text-label-3 tabular">{fmtDateTime(s.created_at).split(" ")[1]}</span>
                  </div>
                ))}
              </Card>
            </Item>
          ))}
        </Stagger>
      )}
      <Modal open={delOpen} onClose={() => setDelOpen(false)} title="セッションを削除" footer={<><Button onClick={() => setDelOpen(false)}>戻る</Button><Button variant="danger" loading={deleting} onClick={remove}>削除する</Button></>}>
        <p className="text-sm text-label-2">このセッションと{sets.length}件のセットを削除します。元に戻せません。</p>
      </Modal>
    </div>
  );
}

function ExerciseHistory() {
  const { key } = useParams();
  const nav = useNavigate();
  const { data, loading, error } = useApi<{ entry: CatalogEntry; sets: (TrainingSet & { started_at: string })[]; best: TrainingSet | null; est_1rm: { value: number; reference: boolean } | null }>(key ? `/training/exercises/${key}/history` : null);
  if (loading && !data) return <PageSkeleton cards={2} />;
  if (!data) return <EmptyState title="種目が見つかりません" hint={error ?? undefined} action={<Button onClick={() => nav("/training/records")}>重量・1RMへ戻る</Button>} />;
  const bySession = new Map<string, (TrainingSet & { started_at: string })[]>(); for (const s of data.sets) { const a = bySession.get(s.session_id) ?? []; a.push(s); bySession.set(s.session_id, a); }
  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={() => nav(-1)} className="-ml-2 pl-1.5"><Icon name="chevron-left" size={18} />戻る</Button>
      <Card>
        <div className="text-2xl font-semibold tracking-tight">{data.entry.name}</div>
        <div className="text-sm text-label-2 mt-1">{data.entry.english_name} ・ {data.entry.part} ・ {EQUIPMENT_LABELS[data.entry.equipment]} ・ {UNIT_LABELS[unitFor(data.entry)]}</div>
        {data.best && <div className="mt-3 text-sm tabular">最高記録 <span className="font-semibold">{describeSet(data.best)}</span>{data.est_1rm && <> ・ 推定1RM <span className="font-semibold">{fmtWeight(data.est_1rm.value)}</span>{data.est_1rm.reference && <Badge tone="orange" className="ml-1">参考値</Badge>}</>} ・ {fmtDate(data.best.created_at)}</div>}
      </Card>
      {data.sets.length === 0 ? <EmptyState title="記録がありません" /> : (
        <Stagger className="space-y-3">
          {[...bySession.entries()].map(([sid, arr]) => (
            <Item key={sid}><Card onClick={() => nav(`/training/history/${sid}`)}>
              <div className="flex items-center justify-between"><span className="text-sm font-medium tabular">{fmtDate(arr[0].started_at)}</span><span className="text-xs text-label-2">{arr.length}セット</span></div>
              <div className="mt-2 flex flex-wrap gap-2">{[...arr].reverse().map((s) => <span key={s.id} className="rounded-full bg-fill px-2.5 py-0.5 text-sm tabular">{describeSet(s)}</span>)}</div>
            </Card></Item>
          ))}
        </Stagger>
      )}
    </div>
  );
}

/* ====================== 種目 ====================== */
function CatalogTab() {
  const [q, setQ] = useState("");
  const [part, setPart] = useState<Part | "">("");
  const [equipment, setEquipment] = useState<Equipment | "">("");
  const items = useMemo(() => searchCatalog(q, { part, equipment }), [q, part, equipment]);
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex gap-2 flex-col sm:flex-row">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="名前・別名・英語名で検索" aria-label="種目を検索" data-testid="catalog-search" />
          <Select value={equipment} onChange={(e) => setEquipment(e.target.value as Equipment | "")} className="sm:w-44" aria-label="器具">
            <option value="">すべての器具</option>{EQUIPMENTS.map((e) => <option key={e} value={e}>{EQUIPMENT_LABELS[e]}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["", ...PARTS] as (Part | "")[]).map((p) => (
            <button key={p || "all"} type="button" aria-pressed={part === p} onClick={() => setPart(p)} className={cx("pressable focus-ring rounded-full px-3 h-8 text-sm font-medium", part === p ? "bg-accent text-white" : "bg-fill text-label hover:bg-fill-strong")} data-testid={`catalog-part-${p || "all"}`}>{p || "すべて"}</button>
          ))}
          <span className="ml-auto self-center text-xs text-label-2 tabular" aria-live="polite">{items.length} / {CATALOG.length}種目</span>
        </div>
      </Card>
      {items.length === 0 ? <EmptyState title="該当する種目がありません" /> : (
        <Stagger className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {items.map((e) => { const legacy = legacyKeysFor(e.key); return (
            <Item key={e.key} className="min-w-0">
              <Card className="h-full min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><div className="font-semibold tracking-tight truncate" data-testid="catalog-item">{e.name}</div><div className="text-xs text-label-2 truncate">{e.english_name}</div></div>
                  <Badge tone="neutral">{UNIT_LABELS[unitFor(e)]}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Badge tone="accent">{e.part}</Badge>{e.secondary_parts.map((p) => <Badge key={p}>{p}</Badge>)}<Badge>{EQUIPMENT_LABELS[e.equipment]}</Badge>
                </div>
                <div className="mt-3 text-xs text-label-2 tabular break-words">目安 {e.rep_min}〜{e.rep_max}回 ・ 増量 {e.increment}kg{e.aliases.length > 0 && <> ・ 別名 {e.aliases.join("、")}</>}</div>
                {legacy.length > 0 && <div className="mt-1 text-xs text-orange">重複統合：旧 {legacy.join("、")} をこの種目に統合</div>}
              </Card>
            </Item>
          ); })}
        </Stagger>
      )}
    </div>
  );
}

/* ====================== 重量・1RM ====================== */
function RecordsTab() {
  const { data, loading, error, reload } = useApi<{ items: ExerciseRecord[] }>("/training/records");
  const nav = useNavigate();
  if (loading && !data) return <PageSkeleton cards={2} />;
  if (!data) return <div><ErrorBanner message={error} onRetry={() => reload()} testId="training-error" /><EmptyState title="記録を読み込めませんでした" /></div>;
  const items = data.items;
  if (items.length === 0) return <EmptyState title="記録がありません" hint="セットを記録すると、種目ごとの最高重量と推定1RMが並びます。" />;
  return (
    <Section title="種目別の最高記録" action={<span className="text-xs text-label-2 text-right">Epley式 重量×(1+回数÷30)。11回以上は参考値。自重・保持時間は「—」。</span>}>
      <Card padded={false}>
        <Table>
          <thead><tr><Th className="pl-5">種目</Th><Th align="right">最高重量</Th><Th align="right">回数</Th><Th align="right">日付</Th><Th align="right" className="pr-5">推定1RM</Th></tr></thead>
          <tbody>
            {items.map((r, i) => {
              const weighted = r.unit === "total" || r.unit === "per_hand" || r.unit === "plate";
              return (
                <motion.tr key={r.exercise_key} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, delay: Math.min(i, 8) * 0.03 }} className={cx(trCls, "hover:bg-fill/50 cursor-pointer focus-within:bg-fill/50")} onClick={() => nav(`/training/exercises/${r.exercise_key}`)} data-testid={`record-row-${r.exercise_key}`}>
                  <Td className="pl-5"><button type="button" className="focus-ring rounded-[var(--radius-sm)] text-left font-medium" onClick={(e) => { e.stopPropagation(); nav(`/training/exercises/${r.exercise_key}`); }} aria-label={`${r.name}の履歴を開く`}>{r.name}</button><div className="text-xs text-label-2">{r.unit ? UNIT_LABELS[r.unit] : "単位不明"} ・ {r.set_count}セット</div></Td>
                  <Td align="right" className="font-medium" data-testid="record-weight">{weighted ? fmtWeight(r.best?.weight) : "—"}</Td>
                  <Td align="right">{r.unit === "time" ? `${r.best?.duration_sec ?? "—"}秒` : `${r.best?.reps ?? "—"}回`}</Td>
                  <Td align="right" className="text-label-2">{fmtDate(r.best?.created_at)}</Td>
                  <Td align="right" className="pr-5" data-testid="record-1rm">{r.est_1rm ? <span className="inline-flex items-center gap-1.5 font-semibold">{fmtWeight(r.est_1rm.value)}{r.est_1rm.reference && <Badge tone="orange">参考値</Badge>}</span> : <span className="text-label-3">—</span>}</Td>
                </motion.tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </Section>
  );
}
