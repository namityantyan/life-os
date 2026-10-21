/** Pieces shared by the health page and the meal tab. */
import { motion } from "motion/react";
import { cx } from "@/components/ui";
import { fmtNum } from "@/lib/api";

export type Nutrition = Record<string, number>;
export type ChatItem = import("@/components/ui").ChatMsg & { id?: string; proposal?: any; applied?: Record<string, unknown> | null };

export const MAIN_NUTRIENTS: { key: string; label: string; unit: string }[] = [
  { key: "energy_kcal", label: "エネルギー", unit: "kcal" }, { key: "protein_g", label: "たんぱく質", unit: "g" }, { key: "fat_g", label: "脂質", unit: "g" },
  { key: "carbs_g", label: "炭水化物", unit: "g" }, { key: "fiber_g", label: "食物繊維", unit: "g" }, { key: "salt_g", label: "食塩相当量", unit: "g" },
];
export const EXTRA_NUTRIENTS: { key: string; label: string; unit: string }[] = [
  { key: "calcium_mg", label: "カルシウム", unit: "mg" }, { key: "iron_mg", label: "鉄", unit: "mg" }, { key: "magnesium_mg", label: "マグネシウム", unit: "mg" }, { key: "zinc_mg", label: "亜鉛", unit: "mg" }, { key: "potassium_mg", label: "カリウム", unit: "mg" },
  { key: "vitamin_a_ug", label: "ビタミンA", unit: "µg" }, { key: "vitamin_b1_mg", label: "ビタミンB1", unit: "mg" }, { key: "vitamin_b2_mg", label: "ビタミンB2", unit: "mg" }, { key: "vitamin_b6_mg", label: "ビタミンB6", unit: "mg" }, { key: "vitamin_b12_ug", label: "ビタミンB12", unit: "µg" },
  { key: "vitamin_c_mg", label: "ビタミンC", unit: "mg" }, { key: "vitamin_d_ug", label: "ビタミンD", unit: "µg" }, { key: "vitamin_e_mg", label: "ビタミンE", unit: "mg" }, { key: "folate_ug", label: "葉酸", unit: "µg" },
];
export const ALL_NUTRIENTS = [...MAIN_NUTRIENTS, ...EXTRA_NUTRIENTS];
export const nutrientLabel = (k: string) => ALL_NUTRIENTS.find((n) => n.key === k) ?? { key: k, label: k, unit: "" };
export const numOrNull = (v: string) => { const t = v.trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };

export function NutrientBar({ label, unit, value, target, partial }: { label: string; unit: string; value: number | null; target: number | null; partial: boolean }) {
  const ratio = value != null && target ? Math.min(1, value / target) : 0;
  return (
    <div className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 text-sm">
      <span className="text-label-2">{label}</span>
      <div className="h-1.5 rounded-full bg-fill overflow-hidden"><motion.div className={cx("h-full rounded-full", partial ? "bg-label-3" : "bg-accent")} initial={{ width: 0 }} animate={{ width: `${ratio * 100}%` }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} /></div>
      <span className="tabular text-right whitespace-nowrap">{value == null ? "—" : fmtNum(value, unit === "g" || unit === "mg" ? 1 : 0)}{target != null ? <span className="text-label-3"> / {fmtNum(target, 0)}</span> : null} <span className="text-label-3 text-xs">{unit}</span></span>
    </div>
  );
}
