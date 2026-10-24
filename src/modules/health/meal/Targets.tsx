/** Daily targets: the main six up front, the rest folded; reference values from 日本人の食事摂取基準. */
import { useState } from "react";
import { Icon } from "@/components/icons";
import { Button, Input, cx } from "@/components/ui";
import { REFERENCE_TARGETS } from "@shared/meals";
import { EXTRA_NUTRIENTS, MAIN_NUTRIENTS, shownText, type Nutrition } from "../shared";
import { Sheet } from "./Sheet";
import { collectNutrition, pfcEnergy } from "./model";

const fieldsOf = (t: Nutrition) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, shownText(k, v)]));

export function TargetsSheet({ open, targets, onClose, onSave }: { open: boolean; targets: Nutrition; onClose: () => void; onSave: (t: Nutrition) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="1日の目標" testId="targets-sheet"
      footer={<><span className="flex-1" /><Button type="button" onClick={onClose} className="max-sm:hidden">キャンセル</Button><Button type="submit" form="targets-form" variant="primary" className="min-w-28" data-testid="targets-save">保存</Button></>}>
      {open && <TargetsForm targets={targets} onClose={onClose} onSave={onSave} />}
    </Sheet>
  );
}

function TargetsForm({ targets, onClose, onSave }: { targets: Nutrition; onClose: () => void; onSave: (t: Nutrition) => void }) {
  const [t, setT] = useState<Record<string, string>>(() => fieldsOf(targets));
  const [extra, setExtra] = useState(() => EXTRA_NUTRIENTS.some((n) => targets[n.key] != null));
  const preset = (k: keyof typeof REFERENCE_TARGETS) => { setT(fieldsOf(REFERENCE_TARGETS[k].targets)); setExtra(true); };
  const input = (defs: typeof MAIN_NUTRIENTS) => defs.map((x) => {
    const full = x.key === "energy_kcal" ? pfcEnergy(t, true) : null;
    return (
      <label key={x.key} className="block space-y-1">
        <span className="block text-xs text-label-2">{x.label}<span className="text-label-3"> {x.unit}{full != null ? "・自動" : ""}</span></span>
        <Input inputMode="decimal" value={full != null ? String(full) : (t[x.key] ?? "")} readOnly={full != null} aria-readonly={full != null} placeholder="未設定"
          className={cx("h-10 tabular", full != null && "opacity-70")} onChange={(e) => setT({ ...t, [x.key]: e.target.value })} data-testid={`nutrient-${x.key}`} />
      </label>
    );
  });
  return (
    <form id="targets-form" className="space-y-5" onSubmit={(e) => { e.preventDefault(); onSave(collectNutrition(t, true)); }}>
      <div className="space-y-2">
        <p className="text-sm text-label-2">日本人の食事摂取基準（2025年版・身体活動ふつう）の値を入れて、そこから調整できます。</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setT({})}>すべて消す</Button>
          {(Object.keys(REFERENCE_TARGETS) as (keyof typeof REFERENCE_TARGETS)[]).map((k) => (
            <Button key={k} type="button" size="sm" variant="tinted" onClick={() => preset(k)} data-testid={`targets-preset-${k}`}>{REFERENCE_TARGETS[k].label}</Button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{input(MAIN_NUTRIENTS)}</div>
      <button type="button" onClick={() => setExtra((v) => !v)} aria-expanded={extra} className="tap focus-ring inline-flex items-center gap-1 text-sm text-accent font-medium h-9 px-1">
        <Icon name={extra ? "chevron-up" : "chevron-down"} size={16} />ミネラル・ビタミン
      </button>
      {extra && <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{input(EXTRA_NUTRIENTS)}</div>}
      <p className="text-xs text-label-3">たんぱく質・脂質・炭水化物をすべて入れると、エネルギーはそこから計算します（4・9・4 kcal/g）。食物繊維・カリウムは「以上」、食塩は「未満」の目標です。ビタミンDは目安量 360IU（9µg）。空欄の項目は目標なしとして扱います。</p>
    </form>
  );
}
