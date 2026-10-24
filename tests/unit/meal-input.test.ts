import { describe, it, expect } from "vitest";
import { parseFoodInput, isGramUnit, REFERENCE_TARGETS } from "../../shared/meals";
import { planNutritionEdit, energyFromPfc, type TableCompute } from "../../worker/modules/health/logic";
import { getTableFood, nutritionFor, searchFoodTable } from "../../worker/modules/health/food-table";

describe("parseFoodInput (quick add)", () => {
  it("takes a trailing amount and unit", () => {
    expect(parseFoodInput("ゆで卵 2個")).toEqual({ name: "ゆで卵", amount: 2, unit: "個", servings: 1 });
    expect(parseFoodInput("ごはん150g")).toEqual({ name: "ごはん", amount: 150, unit: "g", servings: 1 });
    expect(parseFoodInput("牛乳　２００ｍｌ")).toEqual({ name: "牛乳", amount: 200, unit: "ml", servings: 1 });
    expect(parseFoodInput("鶏むね肉 0.3kg")).toEqual({ name: "鶏むね肉", amount: 300, unit: "g", servings: 1 });
    expect(parseFoodInput("オリーブオイル 大さじ1")).toEqual({ name: "オリーブオイル", amount: 1, unit: "大さじ", servings: 1 });
  });
  it("keeps names with numbers inside, plain names, servings and halves", () => {
    expect(parseFoodInput("6枚切り食パン")).toEqual({ name: "6枚切り食パン", amount: null, unit: null, servings: 1 });
    expect(parseFoodInput("納豆")).toEqual({ name: "納豆", amount: null, unit: null, servings: 1 });
    expect(parseFoodInput("納豆 1パック ×2")).toEqual({ name: "納豆", amount: 1, unit: "パック", servings: 2 });
    expect(parseFoodInput("りんご 半分").servings).toBe(0.5);
    expect(parseFoodInput("バナナを1本")).toMatchObject({ name: "バナナ", amount: 1, unit: "本" });
    expect(parseFoodInput("2")).toEqual({ name: "2", amount: null, unit: null, servings: 1 });
  });
  it("knows gram-like units", () => {
    expect(isGramUnit("g")).toBe(true); expect(isGramUnit("ml")).toBe(true); expect(isGramUnit("個")).toBe(false); expect(isGramUnit(null)).toBe(false);
  });
});

describe("reference targets (日本人の食事摂取基準)", () => {
  it("P/F/C add up to the energy (4/9/4), so saving keeps the energy", () => {
    for (const r of Object.values(REFERENCE_TARGETS)) expect(Math.abs(energyFromPfc(r.targets, true)! - r.targets.energy_kcal!)).toBeLessThanOrEqual(5);
    expect(REFERENCE_TARGETS.male.targets.vitamin_d_ug).toBe(9);
  });
});

const compute: TableCompute = (n, g) => { const f = getTableFood(n); return f ? { name: f.name, nutrition: nutritionFor(f, g) } : null; };
const EMPTY = { nutrition: null, source: null, ref: null };

describe("planNutritionEdit", () => {
  it("computes a chosen 成分表 food on the server, times servings", () => {
    const r = planNutritionEdit({ amount: null, unit: null, servings: 1, stored: EMPTY }, { amount: 2, unit: "個", servings: 2 }, { table: { number: "12005", grams: 100 } }, compute);
    expect(r.source).toBe("table");
    expect(r.ref).toMatchObject({ number: "12005", grams: 100, name: "鶏卵 全卵 ゆで" });
    expect(r.nutrition!.energy_kcal).toBe(268); // 134 × 2 servings
    expect(() => planNutritionEdit({ amount: null, unit: null, servings: 1, stored: EMPTY }, { amount: null, unit: null, servings: 1 }, { table: { number: "99999", grams: 1 } }, compute)).toThrow();
  });
  it("typed values are 記録 with the energy rule; AI values are 推定; empty clears", () => {
    const r = planNutritionEdit({ amount: null, unit: null, servings: 1, stored: EMPTY }, { amount: null, unit: null, servings: 1 }, { nutrition: { protein_g: 20, fat_g: 10, carbs_g: 30, energy_kcal: 999 } }, compute);
    expect(r).toMatchObject({ source: "recorded", nutrition: { energy_kcal: 290 } });
    expect(planNutritionEdit({ amount: null, unit: null, servings: 1, stored: EMPTY }, { amount: null, unit: null, servings: 1 }, { nutrition: { energy_kcal: 70, protein_g: 6 }, source: "estimated" }, compute))
      .toEqual({ nutrition: { energy_kcal: 70, protein_g: 6 }, source: "estimated", ref: null });
    expect(planNutritionEdit({ amount: 1, unit: null, servings: 1, stored: { nutrition: { energy_kcal: 5 }, source: "recorded", ref: null } }, { amount: 1, unit: null, servings: 1 }, { nutrition: null }, compute)).toEqual(EMPTY);
  });
  it("a new amount recomputes 成分表 values (grams follow) and scales anything else as 推定", () => {
    const table = { nutrition: nutritionFor(getTableFood("01088")!, 150), source: "table", ref: { number: "01088", name: "ごはん", grams: 150 } };
    const g = planNutritionEdit({ amount: 150, unit: "g", servings: 1, stored: table }, { amount: 200, unit: "g", servings: 1 }, {}, compute);
    expect(g).toMatchObject({ source: "table", ref: { grams: 200 }, nutrition: { energy_kcal: 312 } });
    const egg = { nutrition: nutritionFor(getTableFood("12005")!, 100), source: "table", ref: { number: "12005", name: "鶏卵 全卵 ゆで", grams: 100, grams_estimated: true } };
    expect(planNutritionEdit({ amount: 2, unit: "個", servings: 1, stored: egg }, { amount: 3, unit: "個", servings: 1 }, {}, compute)).toMatchObject({ source: "table", ref: { grams: 150, grams_estimated: true } });
    const rec = { nutrition: { energy_kcal: 60, protein_g: 4 }, source: "recorded", ref: null };
    expect(planNutritionEdit({ amount: 100, unit: "g", servings: 1, stored: rec }, { amount: 200, unit: "g", servings: 1 }, {}, compute)).toEqual({ nutrition: { energy_kcal: 120, protein_g: 8 }, source: "estimated", ref: null });
  });
  it("a change of servings just multiplies the per-serving values and keeps the source", () => {
    const rec = { nutrition: { energy_kcal: 140, protein_g: 12 }, source: "recorded", ref: null }; // 2 servings stored
    expect(planNutritionEdit({ amount: 1, unit: "個", servings: 2, stored: rec }, { amount: 1, unit: "個", servings: 3 }, {}, compute)).toEqual({ nutrition: { energy_kcal: 210, protein_g: 18 }, source: "recorded", ref: null });
  });
});

describe("成分表 search quality", () => {
  it("a plain name does not land on a seasoned / fried form", () => {
    const top = searchFoodTable("ナッツ", 4).map((x) => x.food.name);
    expect(top[0]).toBe("アーモンド いり 無塩");
    expect(top).toContain("くるみ いり");
    expect(searchFoodTable("アーモンド", 1)[0]!.food.name).toBe("アーモンド いり 無塩");
    expect(searchFoodTable("カシューナッツ", 1)[0]!.food.name).toBe("カシューナッツ フライ 味付け"); // the only one in the table
  });
});
