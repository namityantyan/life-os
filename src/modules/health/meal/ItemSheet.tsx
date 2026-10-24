/**
 * One editor for a logged entry, a saved food or a set member. Nutrition has exactly two ways in:
 * 成分表 (pick a food + grams; candidates come from an instant text search, the AI is optional help)
 * or 手入力 (label values; the AI can propose an estimate that is saved as 推定).
 * Saving never waits: the sheet hands the change to the parent, which applies it optimistically.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { Badge, Button, Input, Segmented, Spinner, Toggle, cx } from "@/components/ui";
import { api, fmtNum } from "@/lib/api";
import { isGramUnit } from "@shared/meals";
import { ALL_NUTRIENTS, EXTRA_NUTRIENTS, MAIN_NUTRIENTS, numOrNull, shownText, type Nutrition } from "../shared";
import { Sheet } from "./Sheet";
import { MACROS, SOURCE, TABLE_CREDIT, collectNutrition, forGrams, pfcEnergy, scale, type Candidate, type Source, type TableRef } from "./model";

export type Editable = {
  id: string; kind: "entry" | "food" | "item"; name: string; amount: number | null; unit: string | null; servings: number;
  /** per serving */ costPer: number | null; nutrition: Nutrition | null; source: Source; ref: TableRef | null;
  savedFood?: boolean; // entry already linked to a saved food
};
export type EditPatch = {
  name: string; amount: number | null; unit: string | null; servings: number; costPer: number | null; saveAsFood?: boolean;
  /** undefined = keep (the server rescales for a new amount / servings) */
  nutrition?: { table: { number: string; name: string; grams: number; grams_estimated: boolean; per100g: Nutrition } } | { values: Nutrition | null; source: "recorded" | "estimated" };
  /** re-run the 成分表 lookup after saving (the name changed and nothing was picked) */ relookup?: boolean;
};
type Pick = { number: string; name: string; per100g: Nutrition; grams: string; estimated: boolean };

const toFields = (n: Nutrition | null) => Object.fromEntries(Object.entries(n ?? {}).map(([k, v]) => [k, shownText(k, v)]));
const str = (v: number | null | undefined) => (v == null ? "" : String(v));

export function ItemSheet({ item, onClose, onSave, onDelete, lookup }: {
  item: Editable | null; onClose: () => void; onSave: (p: EditPatch) => void; onDelete?: () => void;
  /** live state of the background lookup for this item */ lookup?: { busy: boolean; candidates?: Candidate[]; note?: string };
}) {
  return (
    <Sheet open={Boolean(item)} onClose={onClose} title={item ? (item.kind === "entry" ? "記録を編集" : item.kind === "food" ? "よく食べるもの" : "セットの食品") : ""} testId="item-sheet"
      footer={item && <>
        {onDelete && <Button type="button" variant="danger" onClick={onDelete} data-testid="entry-delete"><Icon name="delete" size={18} />{item.kind === "entry" ? "削除" : item.kind === "food" ? "一覧から削除" : "セットから外す"}</Button>}
        <span className="flex-1" />
        <Button type="button" onClick={onClose} className="max-sm:hidden">キャンセル</Button>
        <Button type="submit" form="item-form" variant="primary" className="min-w-28" data-testid="entry-save">保存</Button>
      </>}>
      {item && <Editor key={item.id} item={item} onClose={onClose} onSave={onSave} onDelete={onDelete} lookup={lookup} />}
    </Sheet>
  );
}

function Editor({ item, onClose, onSave, onDelete, lookup }: { item: Editable; onClose: () => void; onSave: (p: EditPatch) => void; onDelete?: () => void; lookup?: { busy: boolean; candidates?: Candidate[]; note?: string } }) {
  const [name, setName] = useState(item.name);
  const [amount, setAmount] = useState(str(item.amount));
  const [unit, setUnit] = useState(item.unit ?? "");
  const [servings, setServings] = useState(item.servings);
  const [cost, setCost] = useState(str(item.costPer));
  const [saveFood, setSaveFood] = useState(false);
  const [mode, setMode] = useState<"table" | "manual">(item.source === "recorded" || item.source === "estimated" ? "manual" : "table");
  const [touched, setTouched] = useState(false); // the nutrition section was changed by the user
  // 成分表: the current pick (per100g derived back from stored table values when needed)
  const initialPick = (): Pick | null => {
    const r = item.ref; if (!r || item.source !== "table" || !item.nutrition) return null;
    return { number: r.number, name: r.name, per100g: scale(item.nutrition, 100 / r.grams)!, grams: str(r.grams), estimated: Boolean(r.grams_estimated) };
  };
  const [pick, setPick] = useState<Pick | null>(initialPick);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // 手入力
  const [fields, setFields] = useState<Record<string, string>>(() => (mode === "manual" ? toFields(item.nutrition) : {}));
  const [manualSource, setManualSource] = useState<"recorded" | "estimated">(item.source === "estimated" ? "estimated" : "recorded");
  const [showExtra, setShowExtra] = useState(() => EXTRA_NUTRIENTS.some((n) => item.nutrition?.[n.key] != null && mode === "manual"));

  // The background lookup finished while the sheet was open: take its result unless the user already chose.
  const lastRef = useRef(item.ref?.number);
  useEffect(() => {
    if (touched || item.ref?.number === lastRef.current) return;
    lastRef.current = item.ref?.number; const p = initialPick(); if (p) { setPick(p); setMode("table"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.ref?.number, item.nutrition]);
  useEffect(() => {
    if (!lookup?.note || pick) return;
    setNote(lookup.note);
    // supplements / packaged foods are not in the table: go straight to typing the label values
    if (!touched && lookup.note.includes("ありません")) setMode("manual");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup?.note, pick]);

  // Candidates: instant text search on the name (or the search box), merged with what the AI returned.
  const q = (more && query.trim()) || name.trim();
  useEffect(() => {
    if (!q) { setCands([]); return; }
    let alive = true; setSearching(true);
    const t = setTimeout(async () => {
      try { const r = await api.get<{ items: Candidate[] }>(`/health/meals/table/search?q=${encodeURIComponent(q)}`); if (alive) setCands(r.items); }
      catch { if (alive) setCands([]); } finally { if (alive) setSearching(false); }
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  const list = useMemo(() => {
    const seen = new Set<string>(); const out: Candidate[] = [];
    for (const c of [...(more && query.trim() ? [] : lookup?.candidates ?? []), ...cands]) if (!seen.has(c.number)) { seen.add(c.number); out.push(c); }
    return out;
  }, [cands, lookup?.candidates, more, query]);

  const gramsGuess = () => {
    const a = numOrNull(amount);
    return isGramUnit(unit) && a ? a : numOrNull(pick?.grams ?? "") ?? 100;
  };
  const choose = (c: Candidate) => { setTouched(true); setMode("table"); setNote(null); setPick({ number: c.number, name: c.name, per100g: c.per100g, grams: String(gramsGuess()), estimated: false }); };
  const setGrams = (g: string) => {
    setTouched(true);
    setPick((p) => (p ? { ...p, grams: g, estimated: false } : p));
    if (isGramUnit(unit) || !unit.trim()) { const n = numOrNull(g); if (n) { setAmount(String(n)); if (!unit.trim()) setUnit("g"); } }
  };
  const onAmount = (v: string) => {
    const prev = numOrNull(amount), next = numOrNull(v); setAmount(v);
    if (!pick || !next) return;
    if (isGramUnit(unit)) setPick({ ...pick, grams: String(next) });
    else if (prev && numOrNull(pick.grams)) setPick({ ...pick, grams: String(Math.round(numOrNull(pick.grams)! * (next / prev) * 10) / 10) });
  };
  const askAi = async () => {
    setAiBusy(true); setNote(null);
    try {
      const r = await api.post<{ match: (TableRef & { nutrition: Nutrition }) | null; candidates: Candidate[]; note?: string }>("/health/meals/lookup", { name: name.trim(), amount: numOrNull(amount), unit: unit.trim() || null });
      if (r.candidates?.length) setCands((cs) => [...r.candidates, ...cs.filter((c) => !r.candidates.some((x) => x.number === c.number))]);
      if (r.match) { const c = r.candidates.find((x) => x.number === r.match!.number); setTouched(true); setPick({ number: r.match.number, name: r.match.name, per100g: c?.per100g ?? scale(r.match.nutrition, 100 / r.match.grams)!, grams: String(r.match.grams), estimated: Boolean(r.match.grams_estimated) }); }
      else setNote(r.note ?? "近い食品が見つかりませんでした。下の候補から選ぶか、手入力してください。");
    } catch { setNote("AIに接続できませんでした。下の候補から選んでください。"); } finally { setAiBusy(false); }
  };
  const estimate = async () => {
    setAiBusy(true); setNote(null);
    try {
      const r = await api.post<{ estimate: Nutrition | null; provider: string }>("/health/meals/estimate", { name: name.trim(), amount: numOrNull(amount), unit: unit.trim() || null });
      if (r.estimate) { setTouched(true); setFields(toFields(r.estimate)); setManualSource("estimated"); setShowExtra(EXTRA_NUTRIENTS.some((n) => r.estimate![n.key] != null)); }
      else setNote(r.provider === "fallback" ? "AIに接続できませんでした。" : "推定できませんでした。");
    } catch { setNote("AIに接続できませんでした。"); } finally { setAiBusy(false); }
  };

  // Resulting nutrition (per serving) for the preview line.
  const grams = numOrNull(pick?.grams ?? "");
  const perServing: Nutrition | null = mode === "table" ? (pick && grams ? forGrams(pick.per100g, grams) : touched ? null : item.nutrition)
    : (() => { const n = collectNutrition(fields); return Object.keys(n).length ? n : null; })();
  const total = scale(perServing, servings);

  const canSave = name.trim().length > 0 && !(mode === "table" && pick && !(grams && grams > 0));
  const save = () => {
    if (!canSave) { if (name.trim()) setNote("可食部のグラム数を入れてください"); return; }
    const nameChanged = name.trim() !== item.name;
    const p: EditPatch = { name: name.trim(), amount: numOrNull(amount), unit: unit.trim() || null, servings, costPer: numOrNull(cost), saveAsFood: saveFood || undefined };
    if (mode === "table") {
      if (pick && grams && (touched || item.source !== "table")) p.nutrition = { table: { number: pick.number, name: pick.name, grams, grams_estimated: pick.estimated, per100g: pick.per100g } };
      else if (!pick && (touched || nameChanged || item.source === "recorded" || item.source === "estimated")) { p.nutrition = { values: null, source: "recorded" }; p.relookup = true; }
    } else if (touched || item.source === "table" || item.source == null) {
      const n = collectNutrition(fields); p.nutrition = { values: Object.keys(n).length ? n : null, source: manualSource };
    }
    onSave(p);
  };

  const fieldsFor = (defs: typeof ALL_NUTRIENTS) => defs.map((x) => {
    const full = x.key === "energy_kcal" ? pfcEnergy(fields, true) : null;
    const partial = x.key === "energy_kcal" && full == null ? pfcEnergy(fields) : null;
    return (
      <label key={x.key} className="block space-y-1">
        <span className="block text-xs text-label-2">{x.label}<span className="text-label-3"> {x.unit}{full != null ? "・自動" : ""}</span></span>
        <Input inputMode="decimal" value={full != null ? String(full) : (fields[x.key] ?? "")} readOnly={full != null} aria-readonly={full != null} className={cx("h-10 tabular", full != null && "opacity-70")}
          onChange={(e) => { setTouched(true); setManualSource("recorded"); setFields({ ...fields, [x.key]: e.target.value }); }} placeholder={partial != null ? `${partial}（自動）` : "—"} data-testid={`nutrient-${x.key}`} />
      </label>
    );
  });

  return (
    <form id="item-form" className="space-y-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
      {/* what and how much */}
      <div className="space-y-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="食べたもの" className="h-12 text-lg font-medium" data-testid="entry-name" />
        <div className="grid grid-cols-[1fr_5.5rem] gap-2">
          <label className="block space-y-1"><span className="block text-xs text-label-2">量</span><Input inputMode="decimal" value={amount} onChange={(e) => onAmount(e.target.value)} placeholder="未入力" className="tabular" data-testid="entry-amount" /></label>
          <label className="block space-y-1"><span className="block text-xs text-label-2">単位</span><Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="g / 個" data-testid="entry-unit" /></label>
        </div>
        <div className={cx("grid gap-2", item.kind === "entry" ? "grid-cols-2" : "grid-cols-1")}>
          {item.kind === "entry" && (
            <div className="space-y-1">
              <span className="block text-xs text-label-2" id="servings-label">何回分</span>
              <div className="flex items-center gap-1 h-11 md:h-10 rounded-[var(--control-radius)] bg-fill px-1" role="group" aria-labelledby="servings-label">
                <button type="button" className="tap focus-ring size-9 grid place-items-center rounded-full hover:bg-fill-strong disabled:opacity-35" aria-label="0.5回分へらす" disabled={servings <= 0.5} onClick={() => setServings((s) => Math.max(0.5, Math.round((s - 0.5) * 10) / 10))}><Icon name="minus" size={18} /></button>
                <span className="flex-1 text-center tabular font-medium" data-testid="entry-servings" aria-live="polite">×{fmtNum(servings, servings % 1 ? 1 : 0)}</span>
                <button type="button" className="tap focus-ring size-9 grid place-items-center rounded-full hover:bg-fill-strong" aria-label="0.5回分ふやす" onClick={() => setServings((s) => Math.min(20, Math.round((s + 0.5) * 10) / 10))}><Icon name="plus" size={18} /></button>
              </div>
            </div>
          )}
          <label className="block space-y-1"><span className="block text-xs text-label-2">費用（1回分・円）</span><Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="未入力" className="tabular" data-testid="entry-cost" /></label>
        </div>
      </div>

      {/* nutrition */}
      <section className="space-y-3" aria-label="栄養">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">栄養</h3>
          <Segmented<"table" | "manual"> value={mode} onChange={(m) => { setMode(m); setNote(null); if (m === "manual" && !Object.keys(fields).length && perServing) setFields(toFields(perServing)); }} testId="nutrition-mode"
            options={[{ value: "table", label: "成分表" }, { value: "manual", label: "手入力" }]} />
        </div>

        <div className="rounded-[var(--radius-md)] bg-subtle px-3 py-2.5 text-sm tabular" data-testid="nutrition-preview">
          {lookup?.busy && !touched ? <span className="flex items-center gap-2 text-label-2"><Spinner className="size-3.5" />成分表で探しています…</span>
            : total ? (
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-semibold text-base">{fmtNum(total.energy_kcal)} kcal</span>
                {MACROS.map((m) => <span key={m.key} className="text-label-2">{m.short} {fmtNum(total[m.key], 1)}</span>)}
                {servings !== 1 && <span className="text-label-3 text-xs">×{fmtNum(servings, 1)}回分の合計</span>}
                {mode === "manual" && <Badge tone={SOURCE[manualSource]!.tone}>{SOURCE[manualSource]!.label}</Badge>}
              </span>
            ) : <span className="text-label-3">未計算（栄養は合計に入りません）</span>}
        </div>

        {mode === "table" ? (
          <div className="space-y-3">
            {pick && (
              <div className="rounded-[var(--radius-md)] ring-1 ring-[var(--accent)] bg-accent-soft p-3 space-y-2">
                <div className="flex items-start gap-2"><Badge tone="purple">成分表</Badge><span className="flex-1 min-w-0 text-sm font-medium break-words" data-testid="table-match">{pick.name}</span></div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-label-2 shrink-0">可食部</span>
                  <div className="flex items-center rounded-[var(--control-radius)] bg-fill">
                    <button type="button" className="tap focus-ring size-10 grid place-items-center" aria-label="10g へらす" onClick={() => setGrams(String(Math.max(1, (grams ?? 0) - 10)))}><Icon name="minus" size={16} /></button>
                    <Input inputMode="decimal" value={pick.grams} onChange={(e) => setGrams(e.target.value)} aria-label="可食部のグラム数" data-testid="table-grams" className="w-16 h-10 text-center tabular bg-transparent px-1" />
                    <button type="button" className="tap focus-ring size-10 grid place-items-center" aria-label="10g ふやす" onClick={() => setGrams(String((grams ?? 0) + 10))}><Icon name="plus" size={16} /></button>
                  </div>
                  <span className="text-xs text-label-2">g</span>
                </div>
                {pick.estimated && <p className="text-xs text-label-2">量からAIが見積もったグラム数です。違えば直してください。</p>}
              </div>
            )}
            {note && <p className="text-sm text-orange" role="status">{note}</p>}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-label-2">{pick ? "ほかの候補" : "成分表の候補から選ぶ"}{searching && <Spinner className="size-3 ml-1.5 align-[-1px]" />}</span>
                <button type="button" onClick={askAi} disabled={aiBusy || !name.trim()} className="tap focus-ring inline-flex items-center gap-1 text-sm text-accent font-medium disabled:opacity-40 h-9 px-1" data-testid="table-ai">
                  {aiBusy && <Spinner className="size-3.5" />}AIに選んでもらう
                </button>
              </div>
              <ul className="rounded-[var(--radius-md)] bg-fill/60 divide-y divide-separator overflow-hidden" aria-label="成分表の候補">
                {list.filter((c) => c.number !== pick?.number).slice(0, more ? 12 : 5).map((c) => {
                  const kcal = c.per100g.energy_kcal != null ? Math.round(c.per100g.energy_kcal * gramsGuess() / 100) : null;
                  return (
                    <li key={c.number}>
                      <button type="button" onClick={() => choose(c)} data-testid="table-candidate"
                        className="tap focus-ring w-full flex items-center gap-3 text-left px-3 min-h-11 py-2 text-sm hover:bg-fill">
                        <span className="flex-1 min-w-0 break-words">{c.name}</span>
                        {kcal != null && <span className="text-xs text-label-3 tabular shrink-0">{fmtNum(kcal)} kcal/{fmtNum(gramsGuess())}g</span>}
                      </button>
                    </li>
                  );
                })}
                {!searching && list.filter((c) => c.number !== pick?.number).length === 0 && <li className="px-3 py-3 text-sm text-label-3">候補がありません。下で検索するか、手入力に切り替えてください。</li>}
              </ul>
              {more ? (
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="成分表で検索（例: 鶏卵 ゆで、アーモンド いり）" data-testid="table-search" className="h-10" autoFocus />
              ) : (
                <button type="button" onClick={() => setMore(true)} className="tap focus-ring text-sm text-accent font-medium h-9 px-1">別の名前で検索</button>
              )}
            </div>
            <p className="text-[0.6875rem] text-label-3">{TABLE_CREDIT}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{fieldsFor(MAIN_NUTRIENTS)}</div>
            <button type="button" onClick={() => setShowExtra((v) => !v)} aria-expanded={showExtra} className="tap focus-ring inline-flex items-center gap-1 text-sm text-accent font-medium h-9 px-1">
              <Icon name={showExtra ? "chevron-up" : "chevron-down"} size={16} />ミネラル・ビタミン
            </button>
            {showExtra && <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{fieldsFor(EXTRA_NUTRIENTS)}</div>}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="tinted" onClick={estimate} loading={aiBusy} disabled={!name.trim()} data-testid="estimate-ai">AIで推定値を入れる</Button>
              {note && <span className="text-sm text-orange" role="status">{note}</span>}
            </div>
            <p className="text-xs text-label-3">1回分の値を入れます。たんぱく質・脂質・炭水化物が揃うとエネルギーは自動（4・9・4 kcal/g）、一部だけならエネルギーが空欄のときに補います。パッケージの表示どおりならそのまま「記録」、AIの値は「推定」として保存します。ビタミンDは IU（1µg = 40IU）。</p>
          </div>
        )}
      </section>

      {item.kind === "entry" && !item.savedFood && (
        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-sm">よく食べるものに登録<span className="block text-xs text-label-3">次から1タップで追加できます</span></span>
          <Toggle checked={saveFood} onChange={setSaveFood} label="よく食べるものに登録" />
        </label>
      )}

    </form>
  );
}
