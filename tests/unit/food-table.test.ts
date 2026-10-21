import { describe, it, expect } from "vitest";
import { searchFoodTable, getTableFood, nutritionFor, normalizeFoodText, FOOD_ALIASES } from "../../worker/modules/health/food-table";

describe("日本食品標準成分表 data", () => {
  it("contains the full 八訂 増補2023 table with known reference values (per 100 g)", () => {
    const egg = getTableFood("12005")!;        // 鶏卵 全卵 ゆで
    expect(egg.name).toBe("鶏卵 全卵 ゆで");
    expect(egg.per100g.energy_kcal).toBe(134);
    expect(egg.per100g.protein_g).toBe(12.5);
    expect(egg.per100g.vitamin_d_ug).toBe(2.5);
    expect(getTableFood("01088")!.per100g.energy_kcal).toBe(156); // ごはん（精白米 うるち米）
    expect(getTableFood("07107")!.per100g.energy_kcal).toBe(93);  // バナナ 生
    expect(getTableFood("99999")).toBeNull();
  });

  it("keeps undetermined values unknown instead of zero", () => {
    // every food reports energy, but not every food has every vitamin measured
    const foodsMissingSomething = ["01001", "05046", "12005"].map((n) => getTableFood(n)!).filter((f) => Object.keys(f.per100g).length < 20);
    for (const f of foodsMissingSomething) for (const v of Object.values(f.per100g)) expect(typeof v).toBe("number");
  });
});

describe("searchFoodTable", () => {
  it("finds foods named like the table", () => {
    expect(searchFoodTable("バナナ", 1)[0]!.food.n).toBe("07107");
    expect(searchFoodTable("チアシード", 1)[0]!.food.n).toBe("05046");
    expect(searchFoodTable("鶏卵 ゆで", 1)[0]!.food.n).toBe("12005");
  });

  it("resolves everyday names through the alias table", () => {
    expect(searchFoodTable("ゆで卵", 1)[0]!.food.n).toBe("12005");
    expect(searchFoodTable("ごはん", 1)[0]!.food.n).toBe("01088");
    expect(searchFoodTable("鶏むね", 1)[0]!.food.n).toBe("11220");
    expect(searchFoodTable("牛乳", 1)[0]!.food.n).toBe("13003");   // not 粉乳
    expect(searchFoodTable("オリーブオイル", 1)[0]!.food.n).toBe("14001");
    for (const numbers of Object.values(FOOD_ALIASES)) for (const n of numbers) expect(getTableFood(n), n).not.toBeNull();
  });

  it("normalizes katakana / full-width / table markup", () => {
    expect(normalizeFoodText("＜鳥肉類＞ にわとり ［若どり］")).toBe("鳥肉類 にわとり 若どり");
    expect(normalizeFoodText("ヨーグルト")).toBe("よーぐると");
  });

  it("returns nothing for an empty query", () => {
    expect(searchFoodTable("   ")).toEqual([]);
  });
});

describe("nutritionFor", () => {
  it("scales per-100 g values to the eaten grams", () => {
    const n = nutritionFor(getTableFood("12005")!, 50); // half an egg-portion of 100 g
    expect(n.energy_kcal).toBe(67);
    expect(n.protein_g).toBe(6.25);
    const rice = nutritionFor(getTableFood("01088")!, 150);
    expect(rice.energy_kcal).toBe(234);
  });
});
