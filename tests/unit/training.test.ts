import { describe, it, expect } from "vitest";
import { estimate1RM, pickBest, progressionAdvice, summarizeSession, hasWeightUnit, normalizeSetInput } from "../../worker/modules/training/logic";
import { parseTrainingText, findExercise, findPart } from "../../worker/modules/training/nlp";
import { CATALOG, getExercise, searchCatalog, legacy_keys, canonicalKey, unitFor, PARTS, sortByUsage, lastDoneLabel } from "../../shared/training";

describe("catalog", () => {
  it("has 96 strength exercises plus bouldering with unique keys", () => {
    expect(CATALOG.length).toBe(97);
    expect(new Set(CATALOG.map((e) => e.key)).size).toBe(97);
    expect(CATALOG.filter((e) => e.key !== "bouldering").length).toBe(96);
    for (const e of CATALOG) expect(PARTS).toContain(e.part);
  });
  it("resolves legacy keys to standard entries", () => {
    expect(legacy_keys.imp_239fbb16).toBe("db_shoulder_press");
    expect(canonicalKey("imp_f717abb6")).toBe("seated_row");
    expect(getExercise("imp_5e3eef59")?.key).toBe("pec_fly");
  });
  it("searches by name, alias, english, part and equipment", () => {
    expect(searchCatalog("ベンチプレス")[0].key).toBe("bench_press");
    expect(searchCatalog("bench press")[0].key).toBe("bench_press");
    expect(searchCatalog("懸垂").map((e) => e.key)).toContain("pull_up");
    expect(searchCatalog("胸").every((e) => e.part === "胸" || e.secondary_parts.includes("胸") || e.name.includes("胸"))).toBe(true);
    expect(searchCatalog("スミス").every((e) => e.equipment === "smith" || e.name.includes("スミス"))).toBe(true);
    expect(searchCatalog("", { part: "脚", equipment: "dumbbell" }).every((e) => e.part === "脚" && e.equipment === "dumbbell")).toBe(true);
    expect(searchCatalog("zzzz")).toEqual([]);
  });
  it("derives units: dumbbell per_hand, smith plate, bodyweight, plank time", () => {
    expect(unitFor(getExercise("flat_db_press")!)).toBe("per_hand");
    expect(unitFor(getExercise("smith_squat")!)).toBe("plate");
    expect(unitFor(getExercise("pull_up")!)).toBe("bodyweight");
    expect(unitFor(getExercise("plank")!)).toBe("time");
  });
});

describe("estimate1RM (Epley)", () => {
  it("computes weight × (1 + reps/30)", () => {
    expect(estimate1RM(60, 8)).toEqual({ value: 76, reference: false });
    expect(estimate1RM(62.5, 5)?.value).toBeCloseTo(72.9, 1);
    expect(estimate1RM(100, 10)).toEqual({ value: 133.3, reference: false });
  });
  it("returns the weight itself for 1 rep", () => {
    expect(estimate1RM(80, 1)).toEqual({ value: 80, reference: false });
  });
  it("flags 11+ reps as reference and still computes up to 30", () => {
    expect(estimate1RM(40, 11)).toEqual({ value: 54.7, reference: true });
    expect(estimate1RM(40, 30)).toEqual({ value: 80, reference: true });
  });
  it("rejects reps outside 1..30, non-integer reps and bad weights", () => {
    expect(estimate1RM(60, 0)).toBeNull();
    expect(estimate1RM(60, 31)).toBeNull();
    expect(estimate1RM(60, -3)).toBeNull();
    expect(estimate1RM(60, 2.5)).toBeNull();
    expect(estimate1RM(0, 5)).toBeNull();
    expect(estimate1RM(-10, 5)).toBeNull();
    expect(estimate1RM(NaN, 5)).toBeNull();
    expect(estimate1RM(null, 5)).toBeNull();
    expect(estimate1RM(60, null)).toBeNull();
  });
});

const mk = (o: Partial<{ id: string; weight: number | null; reps: number | null; duration_sec: number | null; unit: string | null; created_at: string }>) =>
  ({ id: o.id ?? Math.random().toString(36).slice(2), weight: o.weight ?? null, reps: o.reps ?? null, duration_sec: o.duration_sec ?? null, unit: "unit" in o ? o.unit ?? null : "total", created_at: o.created_at ?? "2026-01-01T00:00:00Z" });

describe("pickBest", () => {
  it("chooses the max weight across all sets, not the first set", () => {
    const sets = [mk({ id: "a", weight: 60, reps: 8, created_at: "2026-01-01T00:00:00Z" }), mk({ id: "b", weight: 62.5, reps: 5, created_at: "2026-01-01T00:05:00Z" }), mk({ id: "c", weight: 55, reps: 12, created_at: "2026-01-02T00:00:00Z" })];
    const r = pickBest(sets);
    expect(r.best?.id).toBe("b");
    expect(r.est_1rm?.value).toBeCloseTo(72.9, 1);
  });
  it("ties on weight go to more reps, then to the newer set", () => {
    const sets = [mk({ id: "old", weight: 60, reps: 8, created_at: "2026-01-01T00:00:00Z" }), mk({ id: "new", weight: 60, reps: 8, created_at: "2026-01-03T00:00:00Z" }), mk({ id: "more", weight: 60, reps: 10, created_at: "2026-01-02T00:00:00Z" })];
    expect(pickBest(sets).best?.id).toBe("more");
    expect(pickBest(sets.filter((s) => s.id !== "more")).best?.id).toBe("new");
  });
  it("gives no 1RM for bodyweight, time or unknown units", () => {
    const bw = pickBest([mk({ reps: 10, unit: "bodyweight" }), mk({ id: "best", reps: 12, unit: "bodyweight" })]);
    expect(bw.best?.id).toBe("best"); expect(bw.est_1rm).toBeNull();
    const t = pickBest([mk({ duration_sec: 40, unit: "time" }), mk({ id: "long", duration_sec: 70, unit: "time" })]);
    expect(t.best?.id).toBe("long"); expect(t.est_1rm).toBeNull();
    const unk = pickBest([mk({ weight: 100, reps: 5, unit: null }), mk({ weight: 100, reps: 5, unit: "mystery" })]);
    expect(unk.best).toBeNull(); expect(unk.est_1rm).toBeNull();
    const mixed = pickBest([mk({ id: "ok", weight: 50, reps: 5, unit: "total" }), mk({ weight: 100, reps: 5, unit: "mystery" })]);
    expect(mixed.best?.id).toBe("ok");
    expect(hasWeightUnit("per_hand")).toBe(true); expect(hasWeightUnit("plate")).toBe(true); expect(hasWeightUnit(undefined)).toBe(false);
  });
  it("ignores weighted sets with missing weight and keeps per_hand/plate as-recorded", () => {
    const r = pickBest([mk({ weight: null, reps: 10, unit: "total" }), mk({ id: "db", weight: 20, reps: 10, unit: "per_hand" })]);
    expect(r.best?.id).toBe("db"); expect(r.est_1rm?.value).toBeCloseTo(26.7, 1);
    expect(pickBest([]).best).toBeNull();
  });
});

describe("progressionAdvice", () => {
  const bench = getExercise("bench_press")!; // 6-12, +2.5
  it("suggests a starting point without history", () => {
    expect(progressionAdvice([], bench).kind).toBe("start");
    expect(progressionAdvice([], getExercise("plank")!).target_sec).toBe(30);
  });
  it("adds reps until rep_max then adds the increment", () => {
    const h = [{ ...mk({ weight: 60, reps: 8 }), session_id: "s1" }, { ...mk({ weight: 60, reps: 9 }), session_id: "s1" }];
    const a = progressionAdvice(h, bench);
    expect(a.kind).toBe("add_reps"); expect(a.weight).toBe(60); expect(a.target_reps).toBe(9);
    const maxed = [{ ...mk({ weight: 60, reps: 12 }), session_id: "s2" }, { ...mk({ weight: 60, reps: 12 }), session_id: "s2" }, { ...mk({ weight: 55, reps: 12 }), session_id: "s1" }];
    const b = progressionAdvice(maxed, bench);
    expect(b.kind).toBe("add_weight"); expect(b.weight).toBe(62.5); expect(b.target_reps).toBe(6);
  });
  it("handles bodyweight and time exercises by reps / seconds", () => {
    expect(progressionAdvice([{ ...mk({ reps: 8, unit: "bodyweight" }), session_id: "s" }], getExercise("pull_up")!).target_reps).toBe(9);
    expect(progressionAdvice([{ ...mk({ duration_sec: 60, unit: "time" }), session_id: "s" }], getExercise("plank")!).target_sec).toBe(70);
  });
});

describe("summarizeSession", () => {
  it("lists per-exercise best and set counts", () => {
    const s = summarizeSession([{ ...mk({ weight: 60, reps: 8 }), exercise_key: "bench_press" }, { ...mk({ weight: 62.5, reps: 5 }), exercise_key: "bench_press" }, { ...mk({ reps: 10, unit: "bodyweight" }), exercise_key: "pull_up" }], (k) => getExercise(k)?.name ?? k, 42);
    expect(s).toContain("42分・3セット");
    expect(s).toContain("ベンチプレス 62.5kg×5 / 2セット");
    expect(s).toContain("懸垂 10回 / 1セット");
  });
});

describe("nlp: parseTrainingText", () => {
  it("parses weight × reps in several Japanese forms", () => {
    const a = parseTrainingText("ベンチプレス 60kg 8回");
    expect(a).toMatchObject({ type: "set", weight: 60, reps: 8, sets: 1 });
    expect((a as any).exercise.key).toBe("bench_press");
    expect(parseTrainingText("ベンチプレス60キロ8回")).toMatchObject({ type: "set", weight: 60, reps: 8 });
    expect(parseTrainingText("ベンチプレス 62.5kg×5")).toMatchObject({ type: "set", weight: 62.5, reps: 5 });
    expect(parseTrainingText("ベンチプレス 60 8")).toMatchObject({ type: "set", weight: 60, reps: 8 });
    const sq = parseTrainingText("スクワット 80kg 5回 3セット");
    expect(sq).toMatchObject({ type: "set", weight: 80, reps: 5, sets: 3 }); expect((sq as any).exercise.key).toBe("squat");
    expect((parseTrainingText("スミススクワット 60kg 8回") as any).exercise.key).toBe("smith_squat");
    expect(parseTrainingText("ダンベルショルダープレス 16kg 10回 きつい")).toMatchObject({ type: "set", weight: 16, reps: 10, memo: "きつい" });
    expect(parseTrainingText("ＢＥＮＣＨ　ＰＲＥＳＳ　６０ｋｇ　８回")).toMatchObject({ type: "set", weight: 60, reps: 8 });
  });
  it("parses bodyweight reps and timed holds", () => {
    expect(parseTrainingText("懸垂 10回")).toMatchObject({ type: "set", weight: null, reps: 10 });
    expect(parseTrainingText("懸垂 12")).toMatchObject({ type: "set", reps: 12 });
    expect(parseTrainingText("プランク 60秒")).toMatchObject({ type: "set", duration_sec: 60, reps: null, weight: null });
    expect(parseTrainingText("プランク 1分30秒")).toMatchObject({ type: "set", duration_sec: 90 });
  });
  it("does not get confused by digits inside exercise names", () => {
    expect(parseTrainingText("45度レッグプレス 120kg 10回")).toMatchObject({ type: "set", weight: 120, reps: 10 });
  });
  it("parses start / finish / advice", () => {
    expect(parseTrainingText("スクワット開始")).toMatchObject({ type: "start", part: "脚" });
    expect(parseTrainingText("胸トレ開始")).toMatchObject({ type: "start", part: "胸" });
    expect(parseTrainingText("背中やる")).toMatchObject({ type: "start", part: "背中" });
    expect(parseTrainingText("カール開始")).toMatchObject({ type: "start", part: "腕", exercise: null });
    expect(parseTrainingText("開始")).toMatchObject({ type: "start", part: null });
    expect(parseTrainingText("終了")).toEqual({ type: "finish" });
    expect(parseTrainingText("おわり！")).toEqual({ type: "finish" });
    expect(parseTrainingText("ベンチプレス 次の重量は？")).toMatchObject({ type: "advice" });
  });
  it("returns unknown for unparseable text", () => {
    expect(parseTrainingText("").type).toBe("unknown");
    expect(parseTrainingText("こんにちは").type).toBe("unknown");
    expect(parseTrainingText("ベンチプレス").type).toBe("unknown");
    expect(parseTrainingText("ベンチプレス 8回").type).toBe("unknown"); // weight required for weighted exercise
  });
  it("findExercise / findPart helpers", () => {
    expect(findExercise("今日はラットプルダウンをやった")?.key).toBe("lat_pulldown");
    expect(findExercise("なし")).toBeNull();
    expect(findPart("お尻トレ")).toBe("尻");
    expect(findPart("腹筋")).toBe("腹");
  });
});

describe("normalizeSetInput (unit always from the catalog)", () => {
  it("keeps the catalog unit even when the client sends another one, so weights are not dropped", () => {
    const bench = getExercise("bench_press")!;
    expect(normalizeSetInput(bench, { weight: 100, reps: 5 })).toEqual({ unit: "total", weight: 100, reps: 5, duration_sec: null });
    const db = getExercise("db_shoulder_press")!;
    expect(normalizeSetInput(db, { weight: 12, reps: 10 }).unit).toBe("per_hand");
    const smith = getExercise("smith_bench_press")!;
    expect(normalizeSetInput(smith, { weight: 20, reps: 8 }).unit).toBe("plate");
  });
  it("bodyweight exercises never carry a weight; timed exercises carry seconds only", () => {
    const pull = getExercise("pull_up")!;
    expect(normalizeSetInput(pull, { weight: 100, reps: 9 })).toEqual({ unit: "bodyweight", weight: null, reps: 9, duration_sec: null });
    const plank = CATALOG.find((e) => e.measurement === "seconds")!;
    expect(normalizeSetInput(plank, { weight: 5, reps: 3, duration_sec: 45 })).toEqual({ unit: "time", weight: null, reps: null, duration_sec: 45 });
  });
  it("rejects missing reps / seconds / weight", () => {
    expect(() => normalizeSetInput(getExercise("bench_press")!, { reps: 5 })).toThrow(/weight/);
    expect(() => normalizeSetInput(getExercise("bench_press")!, { weight: 60 })).toThrow(/reps/);
    expect(() => normalizeSetInput(getExercise("pull_up")!, {})).toThrow(/reps/);
    expect(() => normalizeSetInput(CATALOG.find((e) => e.measurement === "seconds")!, {})).toThrow(/duration/);
  });
});

describe("setInputMessage", () => {
  it("explains what is missing in Japanese", async () => {
    const { setInputMessage } = await import("../../worker/modules/training/logic");
    expect(setInputMessage("weight required", "ベンチプレス")).toContain("重量が必要");
    expect(setInputMessage("duration_sec required", "プランク")).toContain("秒数");
    expect(setInputMessage("reps required", "懸垂")).toContain("回数が必要");
  });
});

describe("usage ordering", () => {
  const u = (count: number, recent: number, last: string) => ({ count, recent, last });
  it("puts recently frequent items first and keeps unused ones in order", () => {
    const usage = { b: u(50, 0, "2025-01-01T00:00:00Z"), c: u(3, 3, "2026-10-20T00:00:00Z"), d: u(3, 3, "2026-10-21T00:00:00Z") };
    expect(sortByUsage(["a", "b", "c", "d", "e"], (x) => x, usage)).toEqual(["d", "c", "b", "a", "e"]);
    expect(sortByUsage(["a", "b"], (x) => x, undefined)).toEqual(["a", "b"]);
  });
  it("labels the last session by JST day", () => {
    const now = new Date("2026-10-22T03:00:00Z"); // 12:00 JST
    expect(lastDoneLabel("2026-10-21T16:00:00Z", now)).toBe("今日"); // 01:00 JST same day
    expect(lastDoneLabel("2026-10-21T10:00:00Z", now)).toBe("昨日");
    expect(lastDoneLabel("2026-10-19T03:00:00Z", now)).toBe("3日前");
    expect(lastDoneLabel("2026-09-20T03:00:00Z", now)).toBe("4週間前");
    expect(lastDoneLabel("2026-03-04T03:00:00Z", now)).toBe("3/4");
    expect(lastDoneLabel("2025-03-04T03:00:00Z", now)).toBe("2025/3/4");
  });
});
