// Japanese natural-text parser for training commands (Discord / chat). Pure; unit-tested.
import { CATALOG, PARTS, findExactExercise, type CatalogEntry, type Part } from "../../../shared/training";

export type ParsedAction =
  | { type: "start"; part: Part | null; exercise: CatalogEntry | null }
  | { type: "finish" }
  | { type: "set"; exercise: CatalogEntry; weight: number | null; reps: number | null; duration_sec: number | null; sets: number; memo: string | null }
  | { type: "advice"; exercise: CatalogEntry }
  | { type: "unknown"; reason: string };

const nfkc = (s: string) => s.normalize("NFKC");
const strip = (s: string) => nfkc(s).toLowerCase().replace(/[\s　・･\-_()（）]/g, "");

const FINISH_RE = /^(終了|終わり|おわり|おしまい|完了|finish|done|end)[！!。．.]*$/i;
const START_WORDS = /(開始|始める|はじめる|スタート|start)/i;
const ADVICE_WORDS = /(次の重量|次は何|次何|次は|相談|アドバイス|どうする|何kg|advice)/i;

const PART_ALIASES: Record<string, Part> = {
  胸: "胸", むね: "胸", チェスト: "胸", chest: "胸",
  背中: "背中", 背: "背中", せなか: "背中", バック: "背中", back: "背中",
  肩: "肩", かた: "肩", ショルダー: "肩", shoulder: "肩",
  腕: "腕", うで: "腕", アーム: "腕", arm: "腕", arms: "腕",
  脚: "脚", 足: "脚", あし: "脚", レッグ: "脚", leg: "脚", legs: "脚",
  尻: "尻", お尻: "尻", おしり: "尻", 臀部: "尻", グルート: "尻", glute: "尻",
  腹: "腹", 腹筋: "腹", お腹: "腹", はら: "腹", abs: "腹", core: "腹",
  その他: "その他", other: "その他",
};

/** Find the part named in text (longest alias wins), or null. */
export function findPart(text: string): Part | null {
  const t = strip(text);
  let hit: Part | null = null; let len = 0;
  for (const [alias, part] of Object.entries(PART_ALIASES)) {
    const a = strip(alias);
    if (a && t.includes(a) && a.length > len) { hit = part; len = a.length; }
  }
  return hit;
}

/**
 * Generic family words that are not catalog entries themselves. They let "スクワット開始" infer the part,
 * and (only where a conventional default exists) map a bare family word to one standard entry.
 */
const GENERIC_TERMS: { word: string; part: Part; defaultKey: string | null }[] = [
  { word: "スクワット", part: "脚", defaultKey: "squat" },
  { word: "squat", part: "脚", defaultKey: "squat" },
  { word: "ショルダープレス", part: "肩", defaultKey: null },
  { word: "カール", part: "腕", defaultKey: null },
  { word: "ロウ", part: "背中", defaultKey: null },
  { word: "プルダウン", part: "背中", defaultKey: "lat_pulldown" },
  { word: "クランチ", part: "腹", defaultKey: null },
  { word: "ランジ", part: "脚", defaultKey: null },
];

function findGeneric(text: string) {
  const t = strip(text);
  let hit: (typeof GENERIC_TERMS)[number] | null = null; let len = 0;
  for (const g of GENERIC_TERMS) { const w = strip(g.word); if (t.includes(w) && w.length > len) { hit = g; len = w.length; } }
  return hit;
}

/** Find the exercise mentioned in text: exact name/alias/english match on the whole text first, then longest contained name/alias. */
export function findExercise(text: string): CatalogEntry | null {
  const t = strip(text);
  if (!t) return null;
  const exact = findExactExercise(text);
  if (exact) return exact;
  let hit: CatalogEntry | null = null; let len = 0;
  for (const e of CATALOG) {
    for (const cand of [e.name, e.english_name, ...e.aliases]) {
      const c = strip(cand);
      if (c.length >= 2 && t.includes(c) && c.length > len) { hit = e; len = c.length; }
    }
  }
  if (hit) return hit;
  const g = findGeneric(text);
  return g?.defaultKey ? CATALOG.find((e) => e.key === g.defaultKey) ?? null : null;
}

/** Part named in the text, or the part of the exercise / exercise family mentioned. */
export function inferPart(text: string): Part | null {
  return findPart(text) ?? findExercise(text)?.part ?? findGeneric(text)?.part ?? null;
}

const num = "(\\d+(?:\\.\\d+)?)";
const WEIGHT_RE = new RegExp(`${num}\\s*(?:kg|キロ|㎏)`, "i");
const REPS_RE = new RegExp(`${num}\\s*(?:回|レップ|reps?|rep)`, "i");
const SEC_RE = new RegExp(`${num}\\s*(?:秒|sec|s\\b)`, "i");
const MIN_RE = new RegExp(`${num}\\s*(?:分|min)`, "i");
const SETS_RE = new RegExp(`(?:x|×|\\*)\\s*(\\d+)\\s*(?:セット|sets?)|(\\d+)\\s*(?:セット|sets?)`, "i");
const CROSS_RE = new RegExp(`${num}\\s*(?:kg|キロ|㎏)?\\s*[x×*]\\s*(\\d+)(?!\\s*(?:セット|sets?))`, "i");

/** Parse one line of Japanese natural text into a training action. */
export function parseTrainingText(raw: string): ParsedAction {
  const text = nfkc(raw).trim();
  if (!text) return { type: "unknown", reason: "empty" };
  if (FINISH_RE.test(text)) return { type: "finish" };

  const exercise = findExercise(text);

  if (START_WORDS.test(text)) {
    return { type: "start", part: inferPart(text), exercise: exercise ?? null };
  }
  if (exercise && ADVICE_WORDS.test(text)) return { type: "advice", exercise };
  if (!exercise) {
    const part = inferPart(text);
    if (part && /(トレ|やる|やります|する)/.test(text)) return { type: "start", part, exercise: null };
    return { type: "unknown", reason: "no exercise" };
  }

  // Remove the exercise mention so its characters don't collide with numbers (e.g. "45度レッグプレス").
  let rest = text;
  for (const cand of [exercise.name, exercise.english_name, ...exercise.aliases]) {
    const idx = rest.toLowerCase().indexOf(cand.normalize("NFKC").toLowerCase());
    if (idx >= 0) { rest = rest.slice(0, idx) + " " + rest.slice(idx + cand.length); break; }
  }

  let weight: number | null = null, reps: number | null = null, duration: number | null = null, sets = 1;
  const isTime = exercise.measurement === "seconds";
  const isBodyweight = exercise.unit === "bodyweight";
  const setsM = rest.match(SETS_RE);
  if (setsM) { sets = Math.max(1, parseInt(setsM[1] ?? setsM[2], 10)); rest = rest.replace(SETS_RE, " "); }
  const w = rest.match(WEIGHT_RE); if (w) { weight = parseFloat(w[1]); rest = rest.replace(WEIGHT_RE, " "); }
  const r = rest.match(REPS_RE); if (r) { reps = parseInt(r[1], 10); rest = rest.replace(REPS_RE, " "); }
  const m = rest.match(MIN_RE); if (m) { duration = Math.round(parseFloat(m[1]) * 60); rest = rest.replace(MIN_RE, " "); }
  const s = rest.match(SEC_RE); if (s) { duration = (duration ?? 0) + parseInt(s[1], 10); rest = rest.replace(SEC_RE, " "); }
  const cross = rest.match(CROSS_RE);
  if (cross) {
    if (weight == null && !isBodyweight && !isTime) weight = parseFloat(cross[1]);
    else if (reps == null && isBodyweight) reps = parseInt(cross[1], 10);
    if (reps == null) reps = parseInt(cross[2], 10);
    rest = rest.replace(CROSS_RE, " ");
  }
  // Bare numbers: "ベンチプレス 60 8" → weight 60, reps 8; bodyweight "懸垂 10" → reps 10; time "プランク 60" → seconds.
  const bare = (rest.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (isTime) { if (duration == null && bare.length) duration = Math.round(bare[0]); }
  else if (isBodyweight) { if (reps == null && bare.length) reps = Math.round(bare[0]); }
  else {
    if (weight == null && reps == null && bare.length >= 2) { weight = bare[0]; reps = Math.round(bare[1]); }
    else if (weight == null && bare.length) weight = bare[0];
    else if (reps == null && bare.length) reps = Math.round(bare[0]);
  }
  const memo = rest.replace(/\d+(?:\.\d+)?/g, " ").replace(/[\s　、,，.。!！]+/g, " ").trim() || null;
  if (isTime && duration == null) return { type: "unknown", reason: "no duration" };
  if (!isTime && reps == null) return { type: "unknown", reason: "no reps" };
  if (!isTime && !isBodyweight && weight == null) return { type: "unknown", reason: "no weight" };
  return { type: "set", exercise, weight: isBodyweight || isTime ? null : weight, reps: isTime ? null : reps, duration_sec: isTime ? duration : null, sets, memo };
}

export { PARTS };
