import { describe, it, expect } from "vitest";
import { summarizeNutrition, estimateCost, computePersonalThreshold, normalizeOura, parseNutrition, formatSleepDuration, PERSONAL_MIN_LOGS } from "../../worker/modules/health/logic";
import { assessPressure } from "../../worker/core/weather";

describe("summarizeNutrition", () => {
  it("totals recorded values and is complete when every item has nutrition", () => {
    const s = summarizeNutrition([
      { nutrition_json: JSON.stringify({ energy_kcal: 300, protein_g: 20 }), nutrition_source: "recorded" },
      { nutrition_json: JSON.stringify({ energy_kcal: 500, protein_g: 10, fat_g: 12 }), nutrition_source: "estimated" },
    ]);
    expect(s.partial).toBe(false);
    expect(s.totals.energy_kcal).toBe(800);
    expect(s.totals.protein_g).toBe(30);
    expect(s.totals.fat_g).toBe(12);
    expect(s.totals.carbs_g).toBeNull(); // nobody provided it → null, not 0
    expect(s.estimated_count).toBe(1);
    expect(s.partial_keys).toContain("fat_g"); // one nutrition-bearing item lacked fat
  });
  it("marks partial when any item has no nutrition_json", () => {
    const s = summarizeNutrition([{ nutrition_json: JSON.stringify({ energy_kcal: 300 }) }, { nutrition_json: null }]);
    expect(s.partial).toBe(true);
    expect(s.totals.energy_kcal).toBe(300);
    expect(s.with_nutrition).toBe(1);
    expect(s.item_count).toBe(2);
  });
  it("treats invalid JSON as missing and an empty routine as partial", () => {
    expect(summarizeNutrition([{ nutrition_json: "{bad" }]).partial).toBe(true);
    expect(summarizeNutrition([]).partial).toBe(true);
    expect(parseNutrition('{"energy_kcal":"12"}')).toBeNull();
  });
});

describe("estimateCost", () => {
  it("ignores unset costs instead of treating them as 0", () => {
    const c = estimateCost([{ cost_per_serving: 120 }, { cost_per_serving: null }, { cost_per_serving: 80 }, { cost_per_serving: undefined }]);
    expect(c.total).toBe(200);
    expect(c.counted).toBe(2);
    expect(c.missing).toBe(2);
  });
  it("returns null total when nothing is entered", () => {
    expect(estimateCost([{ cost_per_serving: null }]).total).toBeNull();
    expect(estimateCost([]).total).toBeNull();
  });
  it("keeps explicit 0 as a real zero", () => {
    expect(estimateCost([{ cost_per_serving: 0 }]).total).toBe(0);
  });
});

describe("computePersonalThreshold", () => {
  const baseline = Array.from({ length: 48 }, (_, i) => (i % 4) * 0.5); // mean 0.75
  it("is not ready below 5 valid logs", () => {
    const logs = Array.from({ length: 4 }, () => ({ delta3h: -4 }));
    const r = computePersonalThreshold(logs, baseline);
    expect(r.ready).toBe(false);
    expect(r.count).toBe(4);
    if (!r.ready) expect(r.reason).toBe("insufficient");
  });
  it("does not count deleted logs or logs without delta", () => {
    const logs = [...Array.from({ length: 5 }, () => ({ delta3h: -4 })), { delta3h: -4, deleted_at: "x" }, { delta3h: null }];
    const r = computePersonalThreshold(logs, baseline);
    expect(r.count).toBe(5);
    expect(PERSONAL_MIN_LOGS).toBe(5);
  });
  it("is ready at 5 valid logs when symptom deltas are clearly larger than baseline", () => {
    const logs = Array.from({ length: 5 }, () => ({ delta3h: -3.5 }));
    const r = computePersonalThreshold(logs, baseline);
    expect(r.ready).toBe(true);
    if (r.ready) { expect(r.symptom_mean).toBeCloseTo(3.5); expect(r.threshold).toBeGreaterThan(r.baseline_mean); expect(r.threshold).toBeLessThan(3.5); }
  });
  it("is unclear when symptom deltas look like baseline", () => {
    const logs = Array.from({ length: 6 }, () => ({ delta3h: 0.7 }));
    const r = computePersonalThreshold(logs, baseline);
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toBe("unclear");
  });
  it("needs a baseline series", () => {
    const r = computePersonalThreshold(Array.from({ length: 5 }, () => ({ delta3h: -5 })), []);
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toBe("no_baseline");
  });
});

describe("normalizeOura", () => {
  it("merges the four collections per day and keeps missing values null", () => {
    const rows = normalizeOura({
      daily_sleep: [{ day: "2026-10-20", score: 82 }, { day: "2026-10-21", score: 75 }],
      daily_readiness: [{ day: "2026-10-21", score: 70, contributors: { sleep_balance: 88 } }],
      daily_activity: [{ day: "2026-10-21", steps: 6200 }],
      sleep: [
        { day: "2026-10-21", type: "rest", total_sleep_duration: 1800, average_hrv: 20, lowest_heart_rate: 60 },
        { day: "2026-10-21", type: "long_sleep", total_sleep_duration: 25200, average_hrv: 42, lowest_heart_rate: 52 },
      ],
    });
    expect(rows.map((r) => r.day)).toEqual(["2026-10-20", "2026-10-21"]);
    const d21 = rows[1];
    expect(d21).toMatchObject({ sleep_score: 75, readiness_score: 70, sleep_balance: 88, steps: 6200, sleep_duration_sec: 25200, hrv: 42, resting_hr: 52 });
    const d20 = rows[0];
    expect(d20.sleep_score).toBe(82);
    expect(d20.readiness_score).toBeNull();
    expect(d20.steps).toBeNull();
    expect(d20.sleep_balance).toBeNull();
  });
  it("falls back to the longest session when there is no long_sleep", () => {
    const rows = normalizeOura({ sleep: [{ day: "d", type: "sleep", total_sleep_duration: 100, average_hrv: 1 }, { day: "d", type: "sleep", total_sleep_duration: 900, average_hrv: 9 }] });
    expect(rows[0].sleep_duration_sec).toBe(900);
    expect(rows[0].hrv).toBe(9);
  });
  it("formats sleep duration", () => {
    expect(formatSleepDuration(25200 + 12 * 60)).toBe("7時間12分");
    expect(formatSleepDuration(null)).toBe("—");
  });
});

describe("assessPressure thresholds", () => {
  const series = (vals: (number | null)[]) => vals.map((hpa, i) => ({ time: `t${i}`, hpa }));
  const flat = (n: number, v = 1013) => Array.from({ length: n }, () => v);
  it("is stable when nothing moves and nothing is missing", () => {
    const r = assessPressure(series(flat(14)), 13);
    expect(r.level).toBe("stable"); expect(r.missing).toBe(false); expect(r.delta3h).toBe(0);
  });
  it("3h: 2.5 → caution, 4.0 → strong (both directions)", () => {
    const base = flat(14);
    expect(assessPressure(series([...base.slice(0, 13), 1013 - 2.5]), 13).level).toBe("caution");
    expect(assessPressure(series([...base.slice(0, 13), 1013 + 2.4]), 13).level).toBe("stable");
    expect(assessPressure(series([...base.slice(0, 13), 1013 + 4.0]), 13).level).toBe("strong");
  });
  it("6h: 4 → caution, 6 → strong", () => {
    // ramp over 6 hours so 3h delta stays below its caution threshold
    const ramp = (total: number) => [...flat(8), ...Array.from({ length: 6 }, (_, i) => 1013 + (total * (i + 1)) / 6)];
    const r4 = assessPressure(series(ramp(4)), 13);
    expect(r4.delta6h).toBeCloseTo(4); expect(Math.abs(r4.delta3h!)).toBeLessThan(2.5); expect(r4.level).toBe("caution");
    const r6 = assessPressure(series(ramp(-6)), 13);
    expect(r6.delta6h).toBeCloseTo(-6); expect(r6.level).toBe("strong");
  });
  it("12h range: 5 → caution, 8 → strong, even if recent deltas are flat", () => {
    const spike = (amp: number) => { const s = flat(14); s[2] = 1013 + amp; return s; };
    expect(assessPressure(series(spike(5)), 13).level).toBe("caution");
    expect(assessPressure(series(spike(8)), 13).level).toBe("strong");
    expect(assessPressure(series(spike(4.9)), 13).level).toBe("stable");
  });
  it("missing readings never yield 'stable'", () => {
    const s = flat(14) as (number | null)[]; s[5] = null;
    const r = assessPressure(series(s), 13);
    expect(r.missing).toBe(true); expect(r.level).toBe("unknown");
    const r2 = assessPressure(series(flat(3)), 2); // no 3h/6h history
    expect(r2.level).toBe("unknown"); expect(r2.delta3h).toBeNull();
  });
});
