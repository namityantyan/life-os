/**
 * 日本食品標準成分表（八訂）増補2023年 (MEXT) — 2,538 foods, per 100 g edible portion.
 * Lookup: text search narrows the candidates, the AI picks the closest food and converts the
 * amount ("2個", "1本") to edible grams; nutrition is then computed from the table only.
 * 出典: 文部科学省「日本食品標準成分表（八訂）増補2023年」
 */
import table from "./food-table.json";
import type { Env } from "../../env";
import { chatJson } from "../../core/ai";
import type { Nutrition, NutrientKey } from "./logic";

export type TableFood = { n: string; g: number; name: string; refuse: number | null; per100g: Partial<Record<NutrientKey, number>> };
const FOODS = (table as unknown as { foods: TableFood[] }).foods;
export const FOOD_TABLE_SOURCE = (table as unknown as { source: string }).source;
const BY_NUMBER = new Map(FOODS.map((f) => [f.n, f]));

/** NFKC, katakana → hiragana, drop table markup (<>, [], ()), collapse spaces. */
export function normalizeFoodText(s: string): string {
  return s.normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[<>\[\]()（）［］＜＞「」・,、]/g, " ")
    .replace(/\s+/g, " ").trim();
}
const INDEX = FOODS.map((f) => ({ f, norm: normalizeFoodText(f.name), compact: normalizeFoodText(f.name).replace(/\s/g, "") }));

/**
 * Everyday names → table food numbers (first = default). The table uses formal names
 * ("鶏卵 全卵 ゆで", "こめ [水稲めし] 精白米 うるち米"), so these would otherwise not be found by text.
 */
export const FOOD_ALIASES: Record<string, string[]> = {
  "ごはん": ["01088"], "ご飯": ["01088"], "白米": ["01088"], "白ごはん": ["01088"], "ライス": ["01088"],
  "玄米ごはん": ["01085"], "玄米": ["01085"], "食パン": ["01026"], "パスタ": ["01064"], "スパゲッティ": ["01064"],
  "うどん": ["01039"], "そば": ["01128"], "オートミール": ["01004"],
  "ゆで卵": ["12005"], "ゆでたまご": ["12005"], "茹で卵": ["12005"], "目玉焼き": ["12021"], "卵": ["12004"], "たまご": ["12004"], "生卵": ["12004"],
  "牛乳": ["13003"], "豆乳": ["04052", "04053"], "納豆": ["04046"], "豆腐": ["04032"], "木綿豆腐": ["04032"], "絹豆腐": ["04033"], "絹ごし豆腐": ["04033"],
  "鶏むね": ["11220"], "鶏むね肉": ["11220"], "鶏胸肉": ["11220"], "鶏もも": ["11221"], "鶏もも肉": ["11221"], "ささみ": ["11227"], "鶏ささみ": ["11227"],
  "サーモン": ["10144", "10438"], "鮭": ["10134"], "さけ": ["10134"], "さば": ["10154"], "鯖": ["10154"], "まぐろ": ["10253"], "マグロ": ["10253"],
  "豚こま": ["11130"], "豚肉": ["11130"], "牛こま": ["11075"], "牛肉": ["11075"],
  "オリーブオイル": ["14001"], "オリーブ油": ["14001"], "バター": ["14017"], "チーズ": ["13040"], "味噌": ["17045"], "みそ": ["17045"],
  "りんご": ["07148"], "みかん": ["07027"], "アボカド": ["07006"], "トマト": ["06182"], "キャベツ": ["06061"], "ブロッコリー": ["06263"],
  "さつまいも": ["02006"], "じゃがいも": ["02017"], "くるみ": ["05014"], "きな粉": ["04029"], "きなこ": ["04029"],
  "サラダチキン": ["11220"], "焼き鮭": ["10136"], "焼鮭": ["10136"], "塩鮭": ["10139"], "鶏胸": ["11220"], "鶏むね焼き": ["11288"],
  "豚汁": ["18028"], "とん汁": ["18028"], "唐揚げ": ["18054"], "から揚げ": ["18054"], "からあげ": ["18054"], "肉じゃが": ["18036"],
};
/** Exact alias, else the longest alias contained in the query ("鶏むね肉のソテー" → 鶏むね肉). */
function aliasHits(q: string): string[] {
  const t = q.normalize("NFKC").trim(); const c = t.replace(/\s/g, "");
  if (FOOD_ALIASES[t]) return FOOD_ALIASES[t]!;
  if (FOOD_ALIASES[c]) return FOOD_ALIASES[c]!;
  const keys = Object.keys(FOOD_ALIASES).filter((k) => k.length >= 2 && c.includes(k)).sort((a, b) => b.length - a.length);
  return keys.length ? FOOD_ALIASES[keys[0]!]! : [];
}
const COOKING = /\s(生|ゆで|焼き|水煮|蒸し|いり|油いため|素揚げ|天ぷら|から揚げ|フライ|ソテー)$/;
/** The same food in its other cooked forms (むね 皮なし 生 → むね 皮なし 焼き). */
function siblings(f: TableFood): TableFood[] {
  const base = f.name.replace(COOKING, "");
  if (base === f.name) return [];
  return FOODS.filter((x) => x.n !== f.n && x.name.startsWith(base + " ") && COOKING.test(x.name)).slice(0, 6);
}

const bigrams = (s: string) => { const out = new Set<string>(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out; };

/** Ranked text search over the table. Raw/plain forms rank above processed ones on ties. */
export function searchFoodTable(query: string, limit = 20): { food: TableFood; score: number }[] {
  const q = normalizeFoodText(query);
  if (!q) return [];
  const tokens = q.split(" ").filter(Boolean);
  const qc = q.replace(/\s/g, "");
  const qb = bigrams(qc);
  const scored: { food: TableFood; score: number }[] = [];
  for (const { f, norm, compact } of INDEX) {
    let score = 0;
    if (compact === qc) score += 100;
    const hits = tokens.filter((t) => norm.includes(t)).length;
    score += (hits / tokens.length) * 50;
    if (hits === tokens.length) score += 15;
    if (compact.startsWith(qc)) score += 10;
    if (qb.size) { const nb = bigrams(compact); let inter = 0; for (const b of qb) if (nb.has(b)) inter++; score += (2 * inter / (qb.size + nb.size)) * 40; }
    if (score < 12) continue;
    if (/\s生$|^.*\s生\s/.test(norm + " ")) score += 2;        // prefer raw on ties
    score -= Math.min(norm.length, 40) * 0.05;                 // prefer shorter, more generic names
    scored.push({ food: f, score });
  }
  const ranked = scored.sort((a, b) => b.score - a.score);
  const aliasFoods = aliasHits(query).map((n) => BY_NUMBER.get(n)).filter((f): f is TableFood => Boolean(f));
  const aliased = [...aliasFoods.map((food) => ({ food, score: 200 })), ...aliasFoods.flatMap(siblings).map((food) => ({ food, score: 150 }))];
  const seen = new Set(aliased.map((a) => a.food.n));
  return [...aliased, ...ranked.filter((r) => !seen.has(r.food.n))].slice(0, limit);
}

export const getTableFood = (number: string) => BY_NUMBER.get(number) ?? null;

/** per-100 g values scaled to `grams`; keys the table does not report stay absent (unknown, not 0). */
export function nutritionFor(food: TableFood, grams: number): Nutrition {
  const k = grams / 100; const out: Nutrition = {};
  for (const [key, v] of Object.entries(food.per100g)) {
    if (typeof v !== "number") continue;
    const x = v * k;
    out[key as NutrientKey] = key === "energy_kcal" ? Math.round(x) : Math.round(x * 100) / 100;
  }
  return out;
}

const GRAM_UNITS = new Set(["g", "ｇ", "グラム", "ml", "mL", "ミリリットル", "cc"]);
export type TableMatch = { number: string; name: string; grams: number; grams_estimated: boolean; nutrition: Nutrition };
export type LookupResult = { match: TableMatch | null; candidates: { number: string; name: string }[]; method: "ai" | "text" | "none"; note?: string };

/**
 * Resolve a food the user typed ("ゆで卵", 2, "個") to a table food + edible grams.
 * The AI only chooses among real table foods and estimates grams; nutrition always comes from the table.
 */
/** Packaged products and supplements are not in the table; their label values should be typed in. */
const NOT_IN_TABLE = /(プロテイン|サプリ|ビタミン.*(錠|剤|サプリ)|マルチビタミン|ミネラル.*(錠|サプリ)|BCAA|EAA|クレアチン|グリシン|グリシナート|ゼリー飲料)/i;

export async function lookupFood(env: Env, input: { name: string; amount?: number | null; unit?: string | null }): Promise<LookupResult> {
  const name = input.name.trim();
  if (!name) return { match: null, candidates: [], method: "none" };
  if (NOT_IN_TABLE.test(name)) return { match: null, candidates: [], method: "none", note: "サプリや市販品は成分表にありません。パッケージの栄養成分表示を手入力してください。" };
  const unit = (input.unit ?? "").trim();
  const gramsGiven = input.amount != null && input.amount > 0 && (unit === "" ? false : GRAM_UNITS.has(unit)) ? input.amount : null;
  let cands = searchFoodTable(name, 25).map((x) => x.food);

  /** Models often return the food number as a JSON number (7107), dropping the leading zero. */
  const num = (v: unknown): string | null => {
    if (v == null || v === "") return null;
    const digits = String(v).replace(/\D/g, "");
    return digits && digits.length <= 5 ? digits.padStart(5, "0") : null;
  };
  const ask = async (list: TableFood[]) => chatJson<{ number?: string | number | null; grams?: number | string | null; keywords?: string[] }>(env, [
    { role: "system", content: [
      "あなたは管理栄養士です。利用者が食べたものを、日本食品標準成分表の食品の中から最も近い1つに対応付け、可食部の重さ(g)を見積もります。JSONのみで返します。",
      '形式: {"number": "候補の食品番号（5桁の文字列）" | null, "grams": 可食部のグラム数 | null, "keywords": [候補に合うものが無いときに成分表を探し直す検索語]}',
      "number は必ず候補一覧の中から選ぶ。食材そのものが同じものだけを選び、名前が似ているだけの別の食品（サラダチキン→サラダ菜 など）は絶対に選ばない。",
      "調理法（生・ゆで・焼き）や部位を合わせる。料理名なら主な食材の調理後の形を選ぶ（鶏むね肉のソテー→むね 皮なし 焼き、焼き鮭→しろさけ 焼き）。",
      "候補に同じ食材が無いときは null にし、keywords に成分表の書き方の検索語を2〜3個入れる（例: ゆで卵→「鶏卵 ゆで」、ごはん→「こめ めし 精白米」）。市販の加工品・サプリ・プロテインは null。",
      "grams は可食部の重さ。目安: 卵1個50g、ゆで卵1個50g、納豆1パック45g、ごはん茶碗1杯150g、食パン6枚切り1枚60g、バナナ1本(皮なし)100g、りんご1個(皮なし)250g、みかん1個80g、牛乳コップ1杯200g、豆腐1丁300g、鮭1切れ80g、鶏むね肉1枚250g、サラダチキン1個110g、アーモンド1粒1g、ナッツ1つかみ25g、味噌汁1杯の味噌15g。量が無いときは一般的な1食分。",
    ].join("\n") },
    { role: "user", content: `食べたもの: ${name}\n量: ${input.amount ?? "不明"} ${unit || ""}\n候補(番号: 名前):\n${list.map((f) => `${f.n}: ${f.name}`).join("\n") || "(なし)"}` },
  ], { number: null, grams: null, keywords: [] });

  let r = await ask(cands);
  let method: LookupResult["method"] = r.provider === "fallback" ? "text" : "ai";
  if (method === "ai" && (!num(r.data.number) || !cands.some((c) => c.n === num(r.data.number))) && r.data.keywords?.length) {
    const seen = new Set<string>(); const more: TableFood[] = [];
    for (const kw of r.data.keywords.slice(0, 3)) for (const x of searchFoodTable(String(kw), 12)) if (!seen.has(x.food.n)) { seen.add(x.food.n); more.push(x.food); }
    if (more.length) { cands = more.slice(0, 25); const r2 = await ask(cands); if (r2.provider !== "fallback") r = r2; }
  }
  const candidates = cands.slice(0, 12).map((f) => ({ number: f.n, name: f.name }));

  let picked: TableFood | null = null; let grams: number | null = gramsGiven; let estimated = false;
  const chosen = num(r.data.number);
  if (method === "ai" && chosen && cands.some((c) => c.n === chosen)) {
    picked = getTableFood(chosen);
    const g = Number(r.data.grams);
    if (grams == null && Number.isFinite(g) && g > 0 && g < 5000) { grams = Math.round(g * 10) / 10; estimated = true; }
  } else if (method === "text") {
    // Without the AI, only trust an exact or all-token text hit, and only with a gram amount.
    const top = searchFoodTable(name, 1)[0];
    if (top && top.score >= 60) picked = top.food; // exact / alias / all-token hit
  }
  if (!picked) return { match: null, candidates, method, note: method === "ai" ? "成分表に近い食品が見つかりませんでした" : "AIに接続できないため候補から選んでください" };
  if (grams == null) return { match: null, candidates: [{ number: picked.n, name: picked.name }, ...candidates.filter((c) => c.number !== picked!.n)], method, note: "量(g)を入れると計算できます" };
  return { match: { number: picked.n, name: picked.name, grams, grams_estimated: estimated, nutrition: nutritionFor(picked, grams) }, candidates, method };
}
