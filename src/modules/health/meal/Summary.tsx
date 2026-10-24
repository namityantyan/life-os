/** Day summary: energy ring, P/F/C bars, cost, completeness, and the full nutrient list on demand. */
import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Icon } from "@/components/icons";
import { Card, cx, quick } from "@/components/ui";
import { fmtNum, fmtYen } from "@/lib/api";
import { ALL_NUTRIENTS, toShown, type Nutrition } from "../shared";
import { MACROS, summarize } from "./model";

type Sum = ReturnType<typeof summarize>;
const digits = (unit: string) => (unit === "kcal" || unit === "IU" || unit === "µg" ? 0 : 1);

function Ring({ value, target }: { value: number | null; target: number | null }) {
  const r = 46, c = 2 * Math.PI * r;
  const ratio = value != null && target ? value / target : 0;
  const main = Math.min(ratio, 1), over = ratio > 1 ? Math.min(ratio - 1, 1) : 0;
  const label = value == null ? "エネルギー未計算" : `エネルギー ${fmtNum(value)}kcal${target ? `、目標 ${fmtNum(target)}kcal` : ""}`;
  return (
    <div className="relative size-[7.5rem] shrink-0" role="img" aria-label={label}>
      <svg viewBox="0 0 108 108" className="size-full -rotate-90" aria-hidden>
        <circle cx="54" cy="54" r={r} fill="none" stroke="var(--fill)" strokeWidth="9" />
        {target != null && <motion.circle cx="54" cy="54" r={r} fill="none" stroke="var(--accent)" strokeWidth="9" strokeLinecap="round" strokeDasharray={c}
          initial={false} animate={{ strokeDashoffset: c * (1 - main) }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }} />}
        {over > 0 && <motion.circle cx="54" cy="54" r={r} fill="none" stroke="var(--orange)" strokeWidth="9" strokeLinecap="round" strokeDasharray={c}
          initial={false} animate={{ strokeDashoffset: c * (1 - over) }} transition={{ duration: 0.2 }} />}
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center leading-tight">
        <span className="text-2xl font-semibold tabular tracking-tight" data-testid="energy-total">{value == null ? "—" : fmtNum(value)}</span>
        <span className="text-[0.6875rem] text-label-2 tabular">{target ? `/ ${fmtNum(target)} kcal` : "kcal"}</span>
      </div>
    </div>
  );
}

function Bar({ value, target, color, muted }: { value: number | null; target: number | null; color: string; muted?: boolean }) {
  const ratio = value != null && target ? value / target : 0;
  return (
    <div className="h-1.5 rounded-full bg-fill overflow-hidden" aria-hidden>
      <motion.div className="h-full w-full rounded-full origin-left" style={{ background: muted ? "var(--label-3)" : ratio > 1.15 ? "var(--orange)" : color }}
        initial={false} animate={{ scaleX: Math.min(1, ratio) }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }} />
    </div>
  );
}

export function DaySummary({ sum, targets, onTargets, loading }: { sum: Sum; targets: Nutrition; onTargets: () => void; loading?: boolean }) {
  const [all, setAll] = useState(false);
  const { totals, partial, item_count, with_nutrition, estimated_count, partial_keys } = sum.nutrition;
  const energy = totals.energy_kcal ?? null, eTarget = targets.energy_kcal ?? null;
  const hasTargets = Object.keys(targets).length > 0;
  const unknownItems = item_count - with_nutrition;
  return (
    <Card as="section" className="space-y-4" data-testid="meal-summary">
      <div className="flex items-center gap-5">
        <Ring value={item_count ? energy : null} target={eTarget} />
        <div className="flex-1 min-w-0 space-y-2.5">
          {MACROS.map((m) => {
            const v = item_count ? totals[m.key] ?? null : null, t = targets[m.key] ?? null;
            return (
              <div key={m.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="flex items-center gap-1.5 text-label-2 min-w-0"><span className="size-2 rounded-full shrink-0" style={{ background: m.color }} aria-hidden />{m.label}</span>
                  <span className="tabular whitespace-nowrap"><span className="font-medium">{v == null ? "—" : fmtNum(v, 1)}</span><span className="text-label-3">{t != null ? ` / ${fmtNum(t, 0)}` : ""} g</span></span>
                </div>
                <Bar value={v} target={t} color={m.color} muted={partial && item_count > 0 && v != null && partial_keys.includes(m.key)} />
              </div>
            );
          })}
        </div>
      </div>
      {eTarget != null && energy != null && item_count > 0 && (
        <p className="text-sm text-label-2 -mt-1">{energy <= eTarget ? `目標まで あと ${fmtNum(eTarget - energy)} kcal` : `目標を ${fmtNum(energy - eTarget)} kcal 超えています`}{partial ? "（途中の値）" : ""}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="text-label-2">食費 <span className="font-medium text-label tabular" data-testid="meal-cost-total">{sum.cost.total == null ? "未入力" : fmtYen(sum.cost.total)}</span>{sum.cost.missing > 0 && sum.cost.total != null ? <span className="text-label-3">（未入力 {sum.cost.missing}件）</span> : null}</span>
        {item_count > 0 && (unknownItems > 0
          ? <span className="text-orange" data-testid="nutrition-partial">{unknownItems}件の栄養が未計算のため途中の値です</span>
          : <span className="text-label-3" data-testid="nutrition-complete">全{item_count}件で計算{estimated_count ? `（推定 ${estimated_count}件を含む）` : ""}</span>)}
        {loading && <span className="text-label-3">更新中…</span>}
      </div>
      <div className="flex items-center gap-1 -mx-2 -mb-2">
        <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} data-testid="nutrients-toggle"
          className="tap focus-ring inline-flex items-center gap-1 h-11 md:h-9 px-2 rounded-[var(--radius-md)] text-sm font-medium text-accent hover:bg-fill">
          <Icon name={all ? "chevron-up" : "chevron-down"} size={16} />すべての栄養
        </button>
        <span className="flex-1" />
        <button type="button" onClick={onTargets} data-testid="targets-edit" className="tap focus-ring inline-flex items-center gap-1 h-11 md:h-9 px-2 rounded-[var(--radius-md)] text-sm font-medium text-accent hover:bg-fill">
          {hasTargets ? "目標を編集" : "目標を設定"}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {all && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={quick} className="overflow-hidden">
            <ul className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2 pt-1" data-testid="nutrients-all">
              {ALL_NUTRIENTS.map((n) => {
                const raw = item_count ? totals[n.key] ?? null : null, v = raw == null ? null : toShown(n.key, raw);
                const t = targets[n.key] != null ? toShown(n.key, targets[n.key]!) : null;
                const unsure = item_count > 0 && (unknownItems > 0 || partial_keys.includes(n.key));
                return (
                  <li key={n.key} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-label-2">{n.label}</span>
                      <span className="tabular whitespace-nowrap"><span className="font-medium">{v == null ? "—" : fmtNum(v, digits(n.unit))}</span><span className="text-label-3">{t != null ? ` / ${fmtNum(t, digits(n.unit))}` : ""} {n.unit}</span>{unsure && v != null ? <span className="text-xs text-label-3">・一部不明</span> : null}</span>
                    </div>
                    <Bar value={v} target={t} color="var(--accent)" muted={unsure} />
                  </li>
                );
              })}
            </ul>
            {!hasTargets && <p className="text-xs text-label-3 mt-3">目標を設定すると、達成の度合いをバーで表示します。</p>}
            <p className={cx("text-xs text-label-3 mt-2")}>「一部不明」は、その栄養素の値が無い記録を含むことを示します（0としては数えません）。</p>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

/** Seven days ending at the selected day: kcal per day relative to the target. Tapping a day opens it. */
export function WeekStrip({ days, selected, target, onPick }: { days: { day: string; kcal: number | null; count: number }[]; selected: string; target: number | null; onPick: (d: string) => void }) {
  const max = Math.max(target ?? 0, ...days.map((d) => d.kcal ?? 0), 1);
  return (
    <div className="grid grid-cols-7 gap-1" role="group" aria-label="この7日間" data-testid="day-history">
      {days.map((d) => {
        const on = d.day === selected; const h = d.kcal ? Math.max(0.08, d.kcal / max) : 0;
        return (
          <button key={d.day} type="button" onClick={() => onPick(d.day)} aria-pressed={on} aria-label={`${d.day.slice(5).replace("-", "/")} ${d.count ? `${d.count}件${d.kcal != null ? `・${fmtNum(d.kcal)}kcal` : ""}` : "記録なし"}`}
            className={cx("tap focus-ring flex flex-col items-center gap-1 rounded-[var(--radius-md)] py-1.5 transition-colors", on ? "bg-accent-soft" : "hover:bg-fill")}>
            <span className="relative h-9 w-2 rounded-full bg-fill overflow-hidden" aria-hidden>
              {target != null && <span className="absolute inset-x-0 h-px bg-label-3" style={{ bottom: `${(target / max) * 100}%` }} />}
              <span className={cx("absolute inset-x-0 bottom-0 rounded-full", on ? "bg-accent" : d.count ? "bg-label-3" : "")} style={{ height: `${h * 100}%` }} />
            </span>
            <span className={cx("text-[0.6875rem] tabular leading-none", on ? "text-accent font-semibold" : "text-label-2")}>{Number(d.day.slice(8))}</span>
            <span className="text-[0.625rem] text-label-3 leading-none">{["日", "月", "火", "水", "木", "金", "土"][new Date(d.day + "T00:00:00Z").getUTCDay()]}</span>
          </button>
        );
      })}
    </div>
  );
}
