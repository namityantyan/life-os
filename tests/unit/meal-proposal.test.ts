import { describe, it, expect } from "vitest";
import { normalizeMealProposal, normalizeSlot, scaleNutrition } from "../../worker/modules/health/logic";

const existing = [
  { id: "m1", slot: "breakfast", food_name: "ヨーグルト", amount: 100, nutrition: { energy_kcal: 62, protein_g: 3.6 } },
  { id: "m2", slot: "lunch", food_name: "サラダチキン", amount: 115, nutrition: null },
  { id: "m3", slot: "dinner", food_name: "ごはん", amount: 150, nutrition: null },
  { id: "m4", slot: "snack", food_name: "ごはん", amount: 80, nutrition: null },
];

describe("normalizeSlot", () => {
  it("accepts Japanese and English slot names, rejects anything else", () => {
    expect(normalizeSlot("朝")).toBe("breakfast");
    expect(normalizeSlot("夜ごはん")).toBe("dinner");
    expect(normalizeSlot("Snack")).toBe("snack");
    expect(normalizeSlot("夜食")).toBeNull();
    expect(normalizeSlot(3)).toBeNull();
  });
});

describe("normalizeMealProposal", () => {
  it("keeps a valid add and drops one without a slot or name", () => {
    const p = normalizeMealProposal({ routines: [
      { op: "add", slot: "朝", food_name: "バナナ", amount: 1, unit: "本", cost_per_serving: 40 },
      { op: "add", food_name: "枠なし" },
      { op: "add", slot: "lunch", food_name: "   " },
    ] }, existing);
    expect(p.routines).toEqual([{ op: "add", slot: "breakfast", food_name: "バナナ", amount: 1, unit: "本", cost_per_serving: 40, nutrition: null }]);
  });

  it("resolves an update by id or by a unique name, and drops ambiguous or unknown targets", () => {
    const byId = normalizeMealProposal({ routines: [{ op: "update", id: "m1", changes: { amount: 200 } }] }, existing);
    expect(byId.routines).toEqual([{ op: "update", id: "m1", food_name: "ヨーグルト", changes: { amount: 200 } }]);
    const byName = normalizeMealProposal({ routines: [{ op: "update", food_name: "サラダチキン", changes: { cost_per_serving: 250 } }] }, existing);
    expect(byName.routines[0]).toMatchObject({ op: "update", id: "m2" });
    // "ごはん" exists in two slots → ambiguous unless the slot is given
    expect(normalizeMealProposal({ routines: [{ op: "remove", food_name: "ごはん" }] }, existing).routines).toEqual([]);
    expect(normalizeMealProposal({ routines: [{ op: "remove", food_name: "ごはん", target_slot: "夜" }] }, existing).routines)
      .toEqual([{ op: "remove", id: "m3", food_name: "ごはん" }]);
    expect(normalizeMealProposal({ routines: [{ op: "remove", id: "nope" }] }, existing).routines).toEqual([]);
  });

  it("drops no-op updates and invalid numbers, and never touches one item twice", () => {
    expect(normalizeMealProposal({ routines: [{ op: "update", id: "m1", changes: { amount: 100 } }] }, existing).routines).toEqual([]);
    expect(normalizeMealProposal({ routines: [{ op: "update", id: "m1", changes: { amount: -5 } }] }, existing).routines).toEqual([]);
    const twice = normalizeMealProposal({ routines: [
      { op: "update", id: "m1", changes: { amount: 200 } },
      { op: "remove", id: "m1" },
    ] }, existing);
    expect(twice.routines).toHaveLength(1);
  });

  it("keeps targets only when they parse, and caps the number of operations", () => {
    expect(normalizeMealProposal({ targets: { protein_g: 120, bogus_key: 3 } }, existing).targets).toEqual({ protein_g: 120 });
    expect(normalizeMealProposal({ targets: {} }, existing).targets).toBeNull();
    const many = Array.from({ length: 20 }, (_, i) => ({ op: "add", slot: "snack", food_name: `食品${i}` }));
    expect(normalizeMealProposal({ routines: many }, existing).routines).toHaveLength(12);
  });

  it("ignores unknown operations and malformed entries", () => {
    expect(normalizeMealProposal({ routines: [{ op: "drop", id: "m1" }, null, "x", 5] }, existing).routines).toEqual([]);
    expect(normalizeMealProposal(null, existing)).toEqual({ targets: null, routines: [] });
  });
});

describe("scaleNutrition", () => {
  it("scales by the amount ratio and refuses impossible inputs", () => {
    expect(scaleNutrition({ energy_kcal: 62, protein_g: 3.6 }, 100, 200)).toEqual({ energy_kcal: 124, protein_g: 7.2 });
    expect(scaleNutrition({ energy_kcal: 62 }, 0, 200)).toBeNull();
    expect(scaleNutrition(null, 100, 200)).toBeNull();
    expect(scaleNutrition({ energy_kcal: 62 }, 100, null)).toBeNull();
  });
});
