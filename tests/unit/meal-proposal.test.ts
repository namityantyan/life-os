import { describe, it, expect } from "vitest";
import { normalizeMealProposal, scaleNutrition } from "../../worker/modules/health/logic";

const existing = [
  { id: "m1", food_name: "ヨーグルト", amount: 100, nutrition: { energy_kcal: 62, protein_g: 3.6 } },
  { id: "m2", food_name: "サラダチキン", amount: 115, nutrition: null },
  { id: "m3", food_name: "ごはん", amount: 150, nutrition: null },
  { id: "m4", food_name: "ごはん", amount: 80, nutrition: null },
];

describe("normalizeMealProposal", () => {
  it("keeps a valid add and drops one without a name", () => {
    const p = normalizeMealProposal({ entries: [
      { op: "add", food_name: "バナナ", amount: 1, unit: "本", cost: 40 },
      { op: "add", food_name: "   " },
      { op: "add" },
    ] }, existing);
    expect(p.entries).toEqual([{ op: "add", food_name: "バナナ", amount: 1, unit: "本", cost: 40, nutrition: null, save_as_food: true }]);
  });

  it("resolves an update by id or by a unique name, and drops ambiguous or unknown targets", () => {
    const byId = normalizeMealProposal({ entries: [{ op: "update", id: "m1", changes: { amount: 200 } }] }, existing);
    expect(byId.entries).toEqual([{ op: "update", id: "m1", food_name: "ヨーグルト", changes: { amount: 200 } }]);
    const byName = normalizeMealProposal({ entries: [{ op: "update", food_name: "サラダチキン", changes: { cost: 250 } }] }, existing);
    expect(byName.entries[0]).toMatchObject({ op: "update", id: "m2" });
    // "ごはん" is logged twice → ambiguous without an id
    expect(normalizeMealProposal({ entries: [{ op: "remove", food_name: "ごはん" }] }, existing).entries).toEqual([]);
    expect(normalizeMealProposal({ entries: [{ op: "remove", id: "m3" }] }, existing).entries)
      .toEqual([{ op: "remove", id: "m3", food_name: "ごはん" }]);
    expect(normalizeMealProposal({ entries: [{ op: "remove", id: "nope" }] }, existing).entries).toEqual([]);
  });

  it("drops no-op updates and invalid numbers, and never touches one item twice", () => {
    expect(normalizeMealProposal({ entries: [{ op: "update", id: "m1", changes: { amount: 100 } }] }, existing).entries).toEqual([]);
    expect(normalizeMealProposal({ entries: [{ op: "update", id: "m1", changes: { amount: -5 } }] }, existing).entries).toEqual([]);
    const twice = normalizeMealProposal({ entries: [
      { op: "update", id: "m1", changes: { amount: 200 } },
      { op: "remove", id: "m1" },
    ] }, existing);
    expect(twice.entries).toHaveLength(1);
  });

  it("keeps targets only when they parse, and caps the number of operations", () => {
    expect(normalizeMealProposal({ targets: { protein_g: 120, bogus_key: 3 } }, existing).targets).toEqual({ protein_g: 120 });
    expect(normalizeMealProposal({ targets: {} }, existing).targets).toBeNull();
    const many = Array.from({ length: 20 }, (_, i) => ({ op: "add", food_name: `食品${i}` }));
    expect(normalizeMealProposal({ entries: many }, existing).entries).toHaveLength(12);
  });

  it("ignores unknown operations and malformed entries", () => {
    expect(normalizeMealProposal({ entries: [{ op: "drop", id: "m1" }, null, "x", 5] }, existing).entries).toEqual([]);
    expect(normalizeMealProposal(null, existing)).toEqual({ targets: null, entries: [] });
    // the older "routines" key is still accepted
    expect(normalizeMealProposal({ routines: [{ op: "add", food_name: "卵" }] }, existing).entries).toHaveLength(1);
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

describe("energy from PFC", () => {
  it("all of P/F/C → energy follows them; some → only fills a missing energy", async () => {
    const { energyFromPfc, withPfcEnergy } = await import("../../worker/modules/health/logic");
    expect(energyFromPfc({ protein_g: 20, fat_g: 10, carbs_g: 30 })).toBe(290);
    expect(energyFromPfc({ protein_g: 25 }, true)).toBeNull();
    expect(withPfcEnergy({ energy_kcal: 999, protein_g: 20, fat_g: 10, carbs_g: 30 })).toEqual({ energy_kcal: 290, protein_g: 20, fat_g: 10, carbs_g: 30 });
    expect(withPfcEnergy({ energy_kcal: 70, protein_g: 6 })).toEqual({ energy_kcal: 70, protein_g: 6 });
    expect(withPfcEnergy({ protein_g: 25 })).toEqual({ protein_g: 25, energy_kcal: 100 });
    expect(withPfcEnergy({ protein_g: 25 }, true)).toEqual({ protein_g: 25 });
    expect(withPfcEnergy({ energy_kcal: 500 })).toEqual({ energy_kcal: 500 });
  });
});
