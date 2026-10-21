import { describe, it, expect } from "vitest";
import { lookupFood } from "../../worker/modules/health/food-table";

// AI stub: answers like the real model does (food number as a bare JSON number, leading zero dropped).
const env = (reply: unknown) => ({ AI: { run: async () => ({ response: reply }) } }) as never;
const offline = { AI: undefined } as never;

describe("lookupFood", () => {
  it("accepts the food number even when the model drops the leading zero", async () => {
    const r = await lookupFood(env({ number: 7107, grams: 100, keywords: [] }), { name: "バナナ", amount: 1, unit: "本" });
    expect(r.match).toMatchObject({ number: "07107", grams: 100, grams_estimated: true });
    expect(r.match!.nutrition.energy_kcal).toBe(93);
  });

  it("uses typed grams as-is and never lets the model change them", async () => {
    const r = await lookupFood(env({ number: "12005", grams: 999 }), { name: "ゆで卵", amount: 60, unit: "g" });
    expect(r.match).toMatchObject({ number: "12005", grams: 60, grams_estimated: false });
    expect(r.match!.nutrition.energy_kcal).toBe(80);
  });

  it("rejects a number that is not among the candidates (no invented foods)", async () => {
    const r = await lookupFood(env({ number: "99999", grams: 100, keywords: [] }), { name: "バナナ", amount: 1, unit: "本" });
    expect(r.match).toBeNull();
  });

  it("refuses supplements and protein powder instead of matching a lookalike", async () => {
    const r = await lookupFood(env({ number: "01023", grams: 30 }), { name: "ソイプロテイン", amount: 1, unit: "杯" });
    expect(r.match).toBeNull();
    expect(r.note).toMatch(/成分表にありません/);
  });

  it("works offline for exact or alias names when grams are given", async () => {
    expect((await lookupFood(offline, { name: "ごはん", amount: 150, unit: "g" })).match).toMatchObject({ number: "01088", grams: 150 });
    expect((await lookupFood(offline, { name: "納豆", amount: 45, unit: "g" })).match?.nutrition.energy_kcal).toBe(83);
    // without grams it asks for them rather than guessing
    const noGrams = await lookupFood(offline, { name: "バナナ", amount: 1, unit: "本" });
    expect(noGrams.match).toBeNull();
    expect(noGrams.note).toMatch(/量\(g\)/);
  });

  it("finds the cooked form for a dish name through its main ingredient", async () => {
    const r = await lookupFood(env({ number: "11288", grams: null }), { name: "鶏むね肉のソテー", amount: 150, unit: "g" });
    expect(r.match).toMatchObject({ number: "11288", grams: 150 }); // むね 皮なし 焼き
  });
});
