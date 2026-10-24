/** Meal-log helpers shared by the worker and the screen (pure, unit-tested). */

/** Units the quick-add box understands after a number ("ゆで卵 2個", "ごはん150g", "牛乳 200ml"). */
const UNITS = ["kg", "g", "ｇ", "グラム", "ml", "mL", "ミリリットル", "cc", "個", "コ", "本", "枚", "杯", "切れ", "切", "パック", "袋", "粒", "丁", "缶", "皿", "膳", "食", "片", "房", "玉", "尾", "匹", "つかみ", "カップ", "大さじ", "小さじ", "包", "錠", "スクープ"];
const UNIT_RE = UNITS.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|");
const NUM = "[0-9０-９]+(?:[.．][0-9０-９]+)?";
const toHalf = (s: string) => s.replace(/[０-９．]/g, (c) => (c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));

export type ParsedFood = { name: string; amount: number | null; unit: string | null; servings: number };

/**
 * "ゆで卵 2個" → { name: "ゆで卵", amount: 2, unit: "個" }. Also "大さじ1", "×2" (servings), "半分" (0.5).
 * Only a trailing amount is taken, so names with digits inside ("6枚切り食パン") stay intact.
 */
export function parseFoodInput(raw: string): ParsedFood {
  let s = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  let servings = 1;
  const times = s.match(new RegExp(`\\s*[x×*]\\s*(${NUM})$`, "i"));
  if (times) { servings = Number(toHalf(times[1]!)) || 1; s = s.slice(0, times.index).trim(); }
  const half = s.match(/\s*(半分|はんぶん)$/);
  if (half && s.length > half[0].length) return { name: s.slice(0, half.index).replace(/[をの]$/, "").trim(), amount: null, unit: null, servings: servings * 0.5 };
  // "大さじ1" / "小さじ2" put the unit before the number
  const spoon = s.match(new RegExp(`\\s*(大さじ|小さじ)\\s*(${NUM})$`));
  if (spoon && s.length > spoon[0].length) return { name: s.slice(0, spoon.index).replace(/[をの]$/, "").trim(), amount: Number(toHalf(spoon[2]!)), unit: spoon[1]!, servings };
  const m = s.match(new RegExp(`\\s*(${NUM})\\s*(${UNIT_RE})?$`));
  if (m && s.length > m[0].length) {
    let unit = m[2] ?? null; let amount = Number(toHalf(m[1]!));
    if (unit === "kg") { unit = "g"; amount *= 1000; }
    if (unit === "ｇ" || unit === "グラム") unit = "g";
    if (unit === "mL" || unit === "ミリリットル") unit = "ml";
    if (unit === "コ") unit = "個";
    const name = s.slice(0, m.index).replace(/[をの]$/, "").trim();
    if (name) return { name, amount: Number.isFinite(amount) && amount > 0 ? amount : null, unit, servings };
  }
  return { name: s, amount: null, unit: null, servings };
}

/** Grams-like units: table values scale exactly with the amount. */
export const isGramUnit = (u: string | null | undefined) => !!u && /^(g|ｇ|グラム|ml|mL|cc)$/.test(u.trim());

/** 1 µg vitamin D = 40 IU. */
export const VITAMIN_D_IU_PER_UG = 40;

/**
 * Daily reference values from 日本人の食事摂取基準（2025年版）, 30〜49歳・身体活動レベルふつう.
 * Energy: 推定エネルギー必要量. P/F/C: midpoints of the 目標量 ranges (P 15%, F 25%, C 60% of energy),
 * so 4P+9F+4C matches the energy. Fiber / potassium: 目標量 (以上). Salt: 目標量 (未満).
 * Others: 推奨量, vitamin D: 目安量. Values the guideline leaves to the person are not set.
 */
export const REFERENCE_TARGETS: Record<"male" | "female", { label: string; targets: Record<string, number> }> = {
  male: { label: "男性 30〜49歳", targets: { energy_kcal: 2744, protein_g: 103, fat_g: 76, carbs_g: 412, fiber_g: 22, salt_g: 7.5, calcium_mg: 750, iron_mg: 7.5, magnesium_mg: 370, potassium_mg: 3000, vitamin_a_ug: 900, vitamin_c_mg: 100, vitamin_d_ug: 9, folate_ug: 240 } },
  female: { label: "女性 30〜49歳", targets: { energy_kcal: 2049, protein_g: 77, fat_g: 57, carbs_g: 307, fiber_g: 18, salt_g: 6.5, calcium_mg: 650, iron_mg: 10.5, magnesium_mg: 290, potassium_mg: 2600, vitamin_a_ug: 700, vitamin_c_mg: 100, vitamin_d_ug: 9, folate_ug: 240 } },
};
