/** Quick add: type "ゆで卵 2個" and press Enter, or tap a set / saved food. */
import { useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { Button, Card, cx } from "@/components/ui";
import { fmtNum } from "@/lib/api";
import { parseFoodInput } from "@shared/meals";
import type { Food, MealSet } from "./model";

const norm = (s: string) => s.normalize("NFKC").replace(/\s/g, "").toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

export function QuickAdd({ foods, sets, onText, onFood, onSet, onManage, dayLabel }: {
  foods: Food[]; sets: MealSet[]; dayLabel: string;
  onText: (t: string) => Promise<boolean>; onFood: (f: Food) => void; onSet: (s: MealSet) => void; onManage: () => void;
}) {
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const [hi, setHi] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const parsed = parseFoodInput(text);
  const sugg = useMemo(() => {
    const q = norm(parsed.name); if (!q) return [];
    return foods.filter((f) => norm(f.name).includes(q)).slice(0, 5);
  }, [foods, parsed.name]);
  const exact = sugg.some((f) => norm(f.name) === norm(parsed.name));
  type Opt = { key: string; label: string; food?: Food };
  const options: Opt[] = [...(exact ? [] : [{ key: "__text", label: text.trim() }]), ...sugg.map((f) => ({ key: f.id, label: f.name, food: f }))];
  const open = focus && text.trim().length > 0 && sugg.length > 0;

  const tapped = (id: string) => { setFlash(id); setTimeout(() => setFlash((f) => (f === id ? null : f)), 900); };
  const submit = async (opt?: (typeof options)[number]) => {
    const o = opt ?? (open ? options[hi] : undefined);
    if (o?.food) { const amt = parsed.amount != null ? `${o.food.name} ${parsed.amount}${parsed.unit ?? ""}` : o.food.name; setText(""); setHi(0); await onText(parsed.servings !== 1 ? `${amt} ×${parsed.servings}` : amt); return; }
    const t = text.trim(); if (!t) { inputRef.current?.focus(); return; }
    setText(""); setHi(0);
    const ok = await onText(t);
    if (!ok) setText(t);
  };

  return (
    <Card as="section" className="space-y-3" data-testid="quick-add">
      <form className="relative" onSubmit={(e) => { e.preventDefault(); submit(); }} role="search" aria-label={`${dayLabel}に記録`}>
        <div className="flex gap-2">
          <div className="relative flex-1 min-w-0">
            <Icon name="plus" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-label-3 pointer-events-none" />
            <input ref={inputRef} value={text} onChange={(e) => { setText(e.target.value); setHi(0); }} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 120)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (open && e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(options.length - 1, h + 1)); }
                if (open && e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
                if (e.key === "Escape") { setText(""); }
              }}
              placeholder="例: ゆで卵 2個" aria-label="食べたものと量" enterKeyHint="done" autoComplete="off"
              role="combobox" aria-expanded={open} aria-controls="quick-add-list" aria-autocomplete="list" aria-activedescendant={open ? `qa-${hi}` : undefined}
              className="control focus-ring w-full h-12 pl-10 pr-3 bg-fill text-base text-label placeholder:text-label-3 outline-none focus:shadow-[0_0_0_3px_var(--accent-soft)]" data-testid="quick-add-input" />
          </div>
          <Button type="submit" variant="primary" size="lg" className="h-12 px-5" data-testid="entry-add">記録</Button>
        </div>
        {text.trim() && (parsed.amount != null || parsed.servings !== 1) && (
          <p className="text-xs text-label-3 mt-1.5 px-1" aria-live="polite">「{parsed.name}」{parsed.amount != null ? ` ${fmtNum(parsed.amount, 1)}${parsed.unit ?? ""}` : ""}{parsed.servings !== 1 ? ` ×${fmtNum(parsed.servings, 1)}` : ""} として記録します</p>
        )}
        {open && (
          <ul id="quick-add-list" role="listbox" className="popover absolute z-20 left-0 right-0 mt-1.5 py-1 overflow-hidden" data-testid="quick-add-suggestions">
            {options.map((o, i) => (
              <li key={o.key} id={`qa-${i}`} role="option" aria-selected={i === hi}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => submit(o)} className={cx("w-full flex items-center gap-2 px-3 min-h-11 text-left text-sm", i === hi ? "bg-fill" : "hover:bg-fill")}>
                  {o.food ? <><Icon name="enter" size={16} className="text-label-3" /><span className="flex-1 truncate">{o.label}</span><span className="text-xs text-label-3 tabular">{o.food.nutrition?.energy_kcal != null ? `${fmtNum(o.food.nutrition.energy_kcal)} kcal` : "未計算"}</span></>
                    : <><Icon name="plus" size={16} className="text-label-3" /><span className="flex-1 truncate">「{o.label}」を記録</span></>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>

      {(sets.length > 0 || foods.length > 0) ? (
        <div className="-mx-5 px-5 flex gap-2 overflow-x-auto md:flex-wrap md:overflow-visible pb-1 no-scrollbar" data-testid="food-buttons" aria-label="1タップで追加">
          {sets.length > 0 && <span className="contents" data-testid="set-buttons">
            {sets.map((s) => (
              <button key={s.id} type="button" disabled={!s.items.length} onClick={() => { tapped(s.id); onSet(s); }} data-testid={`set-add-${s.name}`}
                title={s.items.map((i) => i.food_name).join("、")} aria-label={`${s.name}（${s.items.length}品）を追加`}
                className="btn tap pressable focus-ring shrink-0 inline-flex items-center gap-1.5 h-11 md:h-9 px-3.5 bg-accent-soft text-accent text-sm font-medium disabled:opacity-40">
                <Icon name={flash === s.id ? "check" : "plus"} size={15} />{s.name}<span className="text-xs opacity-70 tabular">{s.items.length}品{s.nutrition.totals.energy_kcal != null ? `・${fmtNum(s.nutrition.totals.energy_kcal)}` : ""}</span>
              </button>
            ))}
          </span>}
          {foods.slice(0, 16).map((f) => (
            <button key={f.id} type="button" onClick={() => { tapped(f.id); onFood(f); }} data-testid={`food-add-${f.name}`}
              aria-label={`${f.name}を追加`} title={[f.amount != null ? `${fmtNum(f.amount, 1)}${f.unit ?? ""}` : null, f.nutrition?.energy_kcal != null ? `${fmtNum(f.nutrition.energy_kcal)}kcal` : "栄養未計算"].filter(Boolean).join("・")}
              className="btn tap pressable focus-ring shrink-0 inline-flex items-center gap-1.5 h-11 md:h-9 px-3.5 bg-fill text-label text-sm font-medium hover:bg-fill-strong">
              {flash === f.id && <Icon name="check" size={15} className="text-green" />}{f.name}
              {f.nutrition?.energy_kcal != null && <span className="text-xs text-label-3 tabular">{fmtNum(f.nutrition.energy_kcal)}</span>}
            </button>
          ))}
          <button type="button" onClick={onManage} data-testid="sets-manage" className="btn tap focus-ring shrink-0 inline-flex items-center gap-1 h-11 md:h-9 px-3 text-sm font-medium text-accent hover:bg-fill">
            <Icon name="edit" size={15} />編集
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-label-3">よく食べるものやセットを登録すると、ここから1タップで追加できます。</span>
          <Button size="sm" variant="ghost" onClick={onManage} data-testid="sets-manage">登録する</Button>
        </div>
      )}
    </Card>
  );
}
