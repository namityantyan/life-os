import { describe, it, expect } from "vitest";
import { buildActivityPlan, weekStart, mvpaMinutes, walkMinutes, type ActivityDayInput, type ActivityPlanInput } from "../../worker/modules/health/activity";
import { normalizeOura } from "../../worker/modules/health/logic";

// 2026-10-21 is a Wednesday → week starts Mon 2026-10-19, 5 days left including today.
const TODAY = "2026-10-21";
const at = (h: number) => `${TODAY}T${String(h).padStart(2, "0")}:00:00+09:00`;
const day = (o: Partial<ActivityDayInput> = {}): ActivityDayInput => ({ day: TODAY, readiness_score: 75, steps: 3000, ...o });
const plan = (o: Partial<ActivityPlanInput> = {}) => buildActivityPlan({ now: at(15), today: TODAY, days: [day()], strength_days: [], trained_today: false, ...o })!;

describe("weekStart / helpers", () => {
  it("returns the Monday of the JST week", () => {
    expect(weekStart("2026-10-21")).toBe("2026-10-19");
    expect(weekStart("2026-10-19")).toBe("2026-10-19");
    expect(weekStart("2026-10-25")).toBe("2026-10-19"); // Sunday
  });
  it("counts vigorous minutes double and converts steps to brisk-walk minutes", () => {
    expect(mvpaMinutes({ medium_activity_time: 1200, high_activity_time: 600 })).toBe(40);
    expect(mvpaMinutes({})).toBeNull();
    expect(walkMinutes(4200)).toBe(40);
    expect(walkMinutes(0)).toBe(0);
  });
});

describe("buildActivityPlan: daily target", () => {
  it("returns null without any Oura row", () => {
    expect(buildActivityPlan({ now: at(9), today: TODAY, days: [], strength_days: [], trained_today: false })).toBeNull();
  });

  it("normal day, 3,000 steps at 15:00, no Oura target → guideline 8,000 with a concrete gap", () => {
    const p = plan();
    expect(p).toMatchObject({ mode: "push", source: "guideline", steps_target: 8000, steps_left: 5000, walk_minutes_left: 50 });
    expect(p.advice[0]).toBe("15時で3,000歩。目標8,000歩まであと5,000歩 ≒ 早歩き50分。今から30分、夜にもう20分歩きましょう。");
  });

  it("uses Oura's own target when it asks for more than the guideline", () => {
    const p = plan({ days: [day({ target_meters: 9000, equivalent_walking_distance: 2500, meters_to_target: 6500 })] });
    expect(p.source).toBe("oura");
    expect(p.steps_left).toBe(9300); // 6,500 m ÷ 0.7 m/step, rounded up to 100
    expect(p.steps_target).toBe(12300);
    expect(p.oura.target_meters).toBe(9000);
  });

  it("never lets a lenient Oura target go below 8,000 steps", () => {
    const p = plan({ days: [day({ target_meters: 4000, equivalent_walking_distance: 3000, meters_to_target: 1000 })] });
    expect(p).toMatchObject({ source: "guideline", steps_target: 8000, steps_left: 5000 });
  });

  it("aims higher on a high-readiness day", () => {
    const p = plan({ now: at(9), days: [day({ readiness_score: 88, steps: 500 })] });
    expect(p.steps_target).toBe(10000);
    expect(p.advice[0]).toBe("今日の目標は10,000歩（コンディション良好のため上積み）。あと9,500歩 ≒ 早歩き95分、昼までに半分を。");
  });

  it("morning message names the source of the target", () => {
    const p = plan({ now: at(8), days: [day({ steps: 0 })] });
    expect(p.advice[0]).toBe("今日の目標は8,000歩（厚労省の目安）。あと8,000歩 ≒ 早歩き80分、昼までに半分を。");
  });
});

describe("buildActivityPlan: safety branch", () => {
  it("low readiness → active recovery with 6,000 steps, ignoring Oura's target and weekly volume", () => {
    const p = plan({ days: [day({ readiness_score: 55, steps: 2000, target_meters: 9000, meters_to_target: 8000 })] });
    expect(p).toMatchObject({ mode: "recovery", reason: "コンディション55", source: "guideline", steps_target: 6000, steps_left: 4000 });
    expect(p.advice[0]).toBe("コンディション55。今日は積極的休養の日：強い運動は控え、ゆっくり歩いて6,000歩（あと4,000歩 ≒ 40分）。");
    expect(p.advice).toContain("中〜高強度の運動と筋トレは、コンディションが戻ってから。");
    expect(p.advice.join("")).not.toMatch(/WHO基準/);
  });

  it("very low readiness → rest with a small concrete target", () => {
    const p = plan({ days: [day({ readiness_score: 42, steps: 1000 })] });
    expect(p).toMatchObject({ mode: "rest", steps_target: 4000, steps_left: 3000 });
    expect(p.advice[0]).toMatch(/^コンディション42。今日は休養優先/);
  });

  it("raised temperature is treated as an illness signal even with good readiness", () => {
    expect(plan({ days: [day({ readiness_score: 80, temperature_deviation: 0.6 })] })).toMatchObject({ mode: "recovery", reason: "体温が平常より+0.6℃" });
    expect(plan({ days: [day({ readiness_score: 80, temperature_deviation: 1.2 })] }).mode).toBe("rest");
  });
});

describe("buildActivityPlan: week and hourly movement", () => {
  const mon = { day: "2026-10-19", steps: 9000, medium_activity_time: 1200, high_activity_time: 0 };
  const tue = { day: "2026-10-20", steps: 8500, medium_activity_time: 1200, high_activity_time: 0, meters_to_target: 0 };
  const lastWeek = { day: "2026-10-18", steps: 15000, medium_activity_time: 7200, high_activity_time: 3600 };

  it("weekly MVPA shortfall: steps met → push the remaining moderate minutes, then strength days", () => {
    const p = plan({
      days: [lastWeek, mon, tue, day({ steps: 9000, medium_activity_time: 600, high_activity_time: 300 })],
      strength_days: ["2026-10-17", "2026-10-19"],
    });
    expect(p.week).toMatchObject({ start: "2026-10-19", days_left: 5, days_with_data: 3, mvpa_min: 60, vigorous_min: 5, strength_days: 1, goal_days_met: 1 });
    expect(p.steps_left).toBe(0);
    expect(p.advice[0]).toBe("歩数目標クリア。今週の中〜高強度は残り90分、今日は20分の早歩きかジョグを足しましょう。");
    expect(p.advice).toContain("今週の筋トレは1日。週2〜3日が目安なので、あと1日。");
  });

  it("adds a WHO line when steps are still short", () => {
    const p = plan({ days: [mon, day()] });
    expect(p.advice).toContain("今週の中〜高強度は20分。WHO基準の150分まで残り130分（1日30分）。");
  });

  it("all standards met → short confirmation", () => {
    const big = { medium_activity_time: 3600 * 2, high_activity_time: 0 };
    const p = plan({ days: [{ ...mon, ...big }, { ...tue, ...big }, day({ steps: 10000, ...big })], strength_days: ["2026-10-19", "2026-10-20"] });
    expect(p.week.mvpa_min).toBe(360);
    expect(p.advice[0]).toBe("目標クリア。今週の中〜高強度360分・筋トレ2日で基準を満たしています。");
  });

  it("nudges hourly movement when sitting time is long", () => {
    const p = plan({ days: [day({ sedentary_time: 7 * 3600 + 5 * 60 })] });
    expect(p.sedentary_min).toBe(425);
    expect(p.advice).toContain("座っている時間が7時間05分。50分ごとに立って2〜3分歩きましょう（目安は1日8時間未満）。");
  });

  it("stale data: no step count for today, guideline target only", () => {
    const p = plan({ now: at(10), days: [{ day: "2026-10-20", steps: 12000, readiness_score: 40 }] });
    expect(p).toMatchObject({ is_today: false, mode: "push", steps: null, steps_left: null, steps_target: 8000 });
    expect(p.advice[0]).toMatch(/^今日の目安は8,000歩/);
  });

  it("never uses emoji or pictographs", () => {
    const cases = [plan(), plan({ days: [day({ readiness_score: 45 })] }), plan({ days: [day({ sedentary_time: 30000 })] })];
    for (const c of cases) for (const l of c.advice) expect(l).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("normalizeOura: activity fields", () => {
  it("keeps Oura's daily target, intensity split, alerts and contributors", () => {
    const [r] = normalizeOura({
      daily_readiness: [{ day: TODAY, score: 72, temperature_deviation: 0.2 }],
      daily_activity: [{ day: TODAY, steps: 5400, score: 81, target_calories: 450, target_meters: 9000, meters_to_target: 3100, equivalent_walking_distance: 5900,
        active_calories: 300, high_activity_time: 300, medium_activity_time: 1800, low_activity_time: 9000, sedentary_time: 20000, inactivity_alerts: 2,
        high_activity_met_minutes: 40, medium_activity_met_minutes: 120, contributors: { stay_active: 70, move_every_hour: 90, meet_daily_targets: 60, recovery_time: null } }],
    });
    expect(r).toMatchObject({ steps: 5400, activity_score: 81, target_meters: 9000, meters_to_target: 3100, sedentary_time: 20000, inactivity_alerts: 2, temperature_deviation: 0.2 });
    expect(JSON.parse(r!.activity_contributors_json!)).toEqual({ stay_active: 70, move_every_hour: 90, meet_daily_targets: 60 });
  });
});
