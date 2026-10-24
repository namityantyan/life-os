// Pure helpers for the images module (unit-tested): §0 guard, tag normalisation, AI prompt and its parsing.
import { IMAGE_COUNT_MAX, PHOTO_ADULT_NEEDS_R18_MESSAGE, PHOTO_R18_YOUTH_MESSAGE, type ImageModel, type ImageRating } from "../../../shared/images";

/* ---------- §0 keyword guard ----------
 * Mirrors ai-image-business/scripts/safety.py (the service rejects these with 422 too) and adds a few
 * things we can catch before spending an AI call. It is a first filter only: the AI classification below
 * covers real people / named characters / artists, and the service has the last word. */

/** Always refused (minors). Same list as safety.py BANNED_PROMPT_TERMS, plus common variants. */
export const MINOR_TERMS = [
  "loli", "shota", "toddler", "infant", "childlike", "child porn", "underage", "preteen", "pre-teen",
  "little girl", "little boy", "young child", "elementary", "kindergarten",
  "幼女", "幼児", "小学生", "園児", "ロリ", "ショタ", "未成年", "児童",
];
/** Youth-suggesting words: fine in an all-ages picture, refused together with sexual content. */
export const YOUTH_TERMS = [
  "child", "children", "kid", "kids", "teen", "teenage", "teenager", "young girl", "young boy", "schoolgirl", "schoolboy",
  "school uniform", "serafuku", "randoseru", "student", "petite", "flat chest", "aged down", "minor",
  "子供", "子ども", "こども", "少女", "少年", "中学生", "高校生", "女子高生", "女子中学生", "学生", "制服", "幼い", "ランドセル", "jk", "jc", "js",
];
/** Sexual-content words (Japanese and tags). */
export const SEXUAL_TERMS = [
  "nsfw", "nude", "naked", "sex", "sexy", "explicit", "lewd", "ecchi", "hentai", "porn", "nipples", "pussy", "penis", "cum", "erotic", "topless", "bottomless", "underwear only", "lingerie",
  "r18", "r-18", "18禁", "成人向け", "エロ", "えっち", "エッチ", "全裸", "半裸", "裸の", "ヌード", "セックス", "性的", "下着姿", "官能",
];
/** A few obvious existing-character / franchise / studio names. Never complete — the AI check is primary. */
export const NAMED_TERMS = [
  "hatsune miku", "初音ミク", "pikachu", "ピカチュウ", "pokemon", "ポケモン", "doraemon", "ドラえもん", "mario", "マリオ",
  "naruto", "ナルト", "goku", "悟空", "sailor moon", "セーラームーン", "evangelion", "エヴァ", "genshin", "原神",
  "hololive", "ホロライブ", "ghibli", "ジブリ", "disney", "ディズニー", "sanrio", "サンリオ", "hello kitty", "キティ",
];
/** Photo model only: anything that points at a real, identifiable person (deepfake risk). Strict on purpose — the AI check covers names. */
export const REAL_PERSON_TERMS = [
  "celebrity", "celebrities", "famous person", "famous actor", "famous actress", "actor", "actress", "politician", "president", "prime minister", "royal family",
  "influencer", "youtuber", "streamer", "idol", "lookalike", "look-alike", "looks like", "deepfake", "deep fake", "face swap", "faceswap", "real person",
  "芸能人", "有名人", "俳優", "女優", "政治家", "首相", "総理", "大統領", "皇室", "王室", "アイドル", "配信者", "ユーチューバー", "インフルエンサー", "そっくり", "似せて", "に似た", "実在の", "知人", "友達の顔", "元カノ", "元カレ", "ディープフェイク",
];
/** Photo + r18 only: every word that states or suggests an age under adulthood, school, or a youthful look. Refused
 *  (not rewritten). MINOR_TERMS / YOUTH_TERMS are checked too; "girl"/"boy"/"1girl" are not here — for photo r18 they
 *  are rewritten to "woman"/"man" (photoAdultTags). Mirrored in imggen-home/app/safety.py PHOTO_R18_YOUTH_TERMS. */
export const PHOTO_R18_YOUTH_TERMS = [
  "teen", "teens", "teenage", "teenager", "teenagers", "adolescent", "adolescence", "juvenile", "minor", "minors", "underage", "under age", "jailbait",
  "child", "children", "childish", "kid", "kids", "young girl", "young boy", "young-looking", "young looking", "youthful", "youthful face", "baby face", "babyface", "baby-faced",
  "schoolgirl", "schoolgirls", "schoolboy", "schoolboys", "school girl", "school boy", "student", "students", "pupil", "school", "high school", "highschool", "high schooler",
  "middle school", "junior high", "school uniform", "school swimsuit", "sailor uniform", "sailor suit", "serafuku", "gym uniform", "bloomers", "randoseru",
  "lolita", "petite", "tiny", "small body", "flat chest", "flat chested", "flat-chested", "aged down", "jk", "jc", "js", "dk",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "少女", "少年", "女子高生", "女子中学生", "女子小学生", "男子高校生", "男子中学生", "高校生", "中学生", "小学生", "学生", "生徒", "女学生", "制服", "セーラー服", "ブレザー", "体操服", "ブルマ", "スク水", "スクール水着", "ランドセル", "学校", "放課後",
  "ロリ", "ショタ", "幼い", "幼く", "幼げ", "幼顔", "幼児体型", "童顔", "若く見える", "若く見せ", "若い見た目", "あどけな", "小柄", "子供", "子ども", "こども", "未成年", "10代", "十代", "ティーン",
];
/** Stated ages under 20 ("17歳", "16 years old", "15yo") — photo r18 refuses them (adults are drawn as 25+). */
const UNDER_20_AGE = /(^|[^0-9])1?[0-9]\s*(歳|才|yo\b|y\/o|years?[ -]old|year-old)/i;
/** First youth hit for photo r18 (a term, or the stated age). */
export function photoR18YouthHit(text: string): string | null {
  const t = firstHit(text, PHOTO_R18_YOUTH_TERMS);
  if (t) return t;
  const m = UNDER_20_AGE.exec(text.normalize("NFKC"));
  return m ? m[0].replace(/^[^0-9]/, "").trim() : null;
}

/** Photo r18: rewrites the booru-style gender words to adult ones ("1girl"/"girl" -> "a woman"/"woman", "boy" -> "man",
 *  "young woman" -> "woman", a lone "young" dropped), so the photo model never gets a "girl"/"boy" prompt. Gender is kept as written. */
export function photoAdultTags(tags: string): string {
  const out = tags
    .replace(/\b1girl\b/gi, "a woman").replace(/\b1boy\b/gi, "a man")
    .replace(/\b(\d+|multiple) ?girls\b/gi, "$1 women").replace(/\b(\d+|multiple) ?boys\b/gi, "$1 men")
    .replace(/\bgirls\b/gi, "women").replace(/\bgirl\b/gi, "woman").replace(/\bboys\b/gi, "men").replace(/\bboy\b/gi, "man")
    .replace(/\byoung (woman|women|man|men|adult|adults)\b/gi, "$1").replace(/\byoung\b ?/gi, "");
  return normalizeTags(out, "photo");
}

/** "In the style of <artist>" style requests. */
const ARTIST_PATTERNS = [/\bin the style of\b/i, /\bstyle of\b/i, /\bartist:/i, /\(artist\)/i, /\bby artist\b/i, /先生風/, /の画風/, /のタッチで/];
/** Image-to-image requests (text2img only). */
const I2I_PATTERNS = [/\bimg2img\b/i, /\bi2i\b/i, /この(画像|写真|絵)を/, /(画像|写真)を(元|もと)に/, /アップロードした/];

export type GuardResult = { ok: true } | { ok: false; code: "minor" | "named" | "artist" | "i2i" | "real_person" | "photo_adult"; message: string };

const isAscii = (t: string) => /^[\x20-\x7e]+$/.test(t);
/** ASCII terms match on word boundaries (so "mario" does not hit "marionette", "kid" not "kidney"); Japanese terms as substrings. */
export function hasTerm(text: string, term: string): boolean {
  const low = text.normalize("NFKC").toLowerCase();
  const t = term.toLowerCase();
  if (!isAscii(t)) return low.includes(t);
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[ _]");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(low);
}
const firstHit = (text: string, terms: string[]) => terms.find((t) => hasTerm(text, t)) ?? null;

/** Guards one text (the user's words, or the converted tags). `rating` is the rating that would be used.
 *  Photo: anything pointing at a real person is refused at every rating. Photo all-ages refuses sexual / adult words
 *  (choose R18 for that). Photo r18 refuses every age / youth / school word (PHOTO_R18_YOUTH_TERMS, ages under 20). */
export function guardText(text: string, rating: ImageRating = "all_ages", model: ImageModel = "anime"): GuardResult {
  const minor = firstHit(text, MINOR_TERMS);
  if (minor) return { ok: false, code: "minor", message: `「${minor}」を含むため生成できません（未成年を想起させる表現は不可）。` };
  if (model === "photo" && rating === "r18") {
    const y = photoR18YouthHit(text);
    if (y) return { ok: false, code: "minor", message: `「${y}」を含むため生成できません。${PHOTO_R18_YOUTH_MESSAGE}` };
  }
  const youth = firstHit(text, YOUTH_TERMS);
  if (youth && (rating === "r18" || firstHit(text, SEXUAL_TERMS))) return { ok: false, code: "minor", message: `「${youth}」と性的な表現の組み合わせは生成できません（未成年に見える人物の性的表現は不可）。` };
  if (model === "photo" && rating !== "r18" && (explicitlyAdult(text) || firstHit(text, SEXUAL_TERMS))) return { ok: false, code: "photo_adult", message: PHOTO_ADULT_NEEDS_R18_MESSAGE };
  const real = model === "photo" ? firstHit(text, REAL_PERSON_TERMS) : null;
  if (real) return { ok: false, code: "real_person", message: `「${real}」を含むため生成できません（実写では実在の人物・実在の人物に似せた画像は作れません）。` };
  const named = firstHit(text, NAMED_TERMS);
  if (named) return { ok: false, code: "named", message: `「${named}」は既存の作品・キャラクター名のため生成できません。` };
  if (ARTIST_PATTERNS.some((p) => p.test(text))) return { ok: false, code: "artist", message: "特定の作家・絵柄の指定は生成できません。" };
  if (I2I_PATTERNS.some((p) => p.test(text))) return { ok: false, code: "i2i", message: "画像を元にした変換はできません（文章からの生成のみ）。" };
  return { ok: true };
}

/** True when the user's own words explicitly ask for adult content (r18 is never inferred from anything else). */
export const explicitlyAdult = (text: string) => /r-?18|18禁|成人向け|nsfw/i.test(text.normalize("NFKC"));

/* ---------- tags ---------- */

/** Quality / meta tags the backend adds itself, and rating tags (rating is a separate parameter). */
const DROP_TAGS = new Set([
  "masterpiece", "best quality", "high quality", "amazing quality", "very aesthetic", "aesthetic", "absurdres", "highres", "ultra detailed", "extremely detailed",
  "newest", "recent", "low quality", "worst quality", "bad quality", "normal quality", "8k", "4k",
  "nsfw", "sfw", "safe", "general", "sensitive", "questionable", "explicit",
]);
export const MAX_TAGS = 60;

/** Photo-quality words the service appends itself (RealVisXL preset). */
const DROP_PHOTO = new Set(["photorealistic", "photo realistic", "realistic", "hyperrealistic", "hyper realistic", "ultra realistic", "raw photo", "photo", "photograph", "high detail", "highly detailed", "sharp focus", "dslr", "uhd", "hdr", "film grain"]);

/** Normalises a tag string: lower-case, comma separated, no duplicates, no quality/rating tags, ASCII only. */
export function normalizeTags(raw: string | string[], model: ImageModel = "anime"): string {
  const parts = (Array.isArray(raw) ? raw : raw.split(/[,\n、，;]+/))
    .map((t) => t.normalize("NFKC").toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim())
    .map((t) => t.replace(/^[\s"'`]+|[\s"'`.]+$/g, ""))
    .filter((t) => t && t.length <= 60 && /^[a-z0-9 ()':.!?/&+\-]+$/.test(t))
    .filter((t) => !DROP_TAGS.has(t) && !(model === "photo" && DROP_PHOTO.has(t)) && !t.startsWith("rating:") && !/^(score|year) ?\d/.test(t));
  return Array.from(new Set(parts)).slice(0, MAX_TAGS).join(", ");
}

/** The input already looks like English tags (then no AI conversion is needed when the AI is down). */
export const looksLikeTags = (text: string) => isAscii(text.replace(/\s+/g, " ").trim()) && /[a-z]/i.test(text);

export const clampCount = (n: unknown, fallback = 1) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(IMAGE_COUNT_MAX, v) : fallback;
};

/* ---------- AI conversion ---------- */

export const IMAGE_SYSTEM_PROMPT = `あなたは画像生成プロンプトの変換係です。ユーザーの日本語の依頼を、画像生成モデル（Animagine XL）向けの英語danbooruタグに変換し、JSONだけを返します。

ルール:
- tags は英語のdanbooruタグをカンマ区切りで（例:「花畑の白ワンピの女の子」→ "1girl, solo, flower garden, white dress, gentle smile"）。人数タグ（1girl, 2boys, no humans 等）を先頭に。
- 品質タグ（masterpiece, best quality など）と rating タグは付けない（バックエンドが自動で付ける）。
- rating は既定 "all_ages"。ユーザーが明確に成人向け（R18・18禁など）を求めたときだけ "r18"。
- count はユーザーが枚数を言ったときだけ 1〜${IMAGE_COUNT_MAX} の整数、言っていなければ null。

次の依頼は絶対に変換せず refuse に理由コードを入れる（婉曲・暗示でも同じ）:
- "minor": 未成年・未成年に見える人物（子供、幼い見た目、小中高生など）を性的に描く依頼
- "real_person": 実在の人物（芸能人、政治家、配信者、知人など）
- "named_character": 既存のアニメ・ゲーム・漫画などの特定キャラクターや作品
- "artist": 特定の作家・イラストレーター・スタジオの絵柄の指定
- "image_input": ユーザーが手元の画像・写真を渡してそれを変換させる依頼（「この写真を」「添付の画像を元に」など）。「実写」「写真風」「リアル」などの画風の指定はこれに当たらない（realistic, photorealistic などのタグにする）
問題がなければ refuse は null。

出力形式（このJSONだけ）:
{"refuse": null | "minor" | "real_person" | "named_character" | "artist" | "image_input", "reason": "断るときの日本語の一言（それ以外は空）", "tags": "…", "rating": "all_ages" | "r18", "count": null | 1}`;

/** Photo model (RealVisXL V5.0), all-ages: plain English descriptive phrases, no sexual content, stricter on real people. */
export const PHOTO_SYSTEM_PROMPT = `あなたは画像生成プロンプトの変換係です。ユーザーの日本語の依頼を、実写系の画像生成モデル（RealVisXL）向けの英語の描写フレーズに変換し、JSONだけを返します。

ルール:
- tags は英語の短い描写フレーズをカンマ区切りで。被写体・見た目・服装・動作・場所・光・構図の順に、自然な英語で書く（例:「花畑で白いワンピースの女性が微笑む」→ "a woman in her twenties wearing a white sundress, gentle smile, standing in a flower field, soft afternoon sunlight, shallow depth of field, medium shot"）。
- danbooruタグ（1girl, solo など）は使わない。人物は "a woman", "a man", "two people" のように書く。人物は大人として書く。
- 品質・画質の語（masterpiece, best quality, photorealistic, raw photo, 8k, high detail など）と rating は付けない（バックエンドが自動で付ける）。
- rating は常に "all_ages"（この依頼は全年齢として作る。成人向けにするときはユーザーが区分で R18 を選ぶ）。
- count はユーザーが枚数を言ったときだけ 1〜${IMAGE_COUNT_MAX} の整数、言っていなければ null。

次の依頼は絶対に変換せず refuse に理由コードを入れる（婉曲・暗示でも同じ）:
- "adult": 性的・裸・下着姿・きわどい・成人向け（R18・18禁など）の依頼（全年齢では作らない）
- "minor": 未成年・未成年に見える人物を性的・きわどく描く依頼
- "real_person": 実在の人物すべて（芸能人、政治家、配信者、スポーツ選手、知人、家族、元恋人など）。名前の一部・あだ名・「〇〇に似た」「〇〇そっくり」「〇〇風の顔」も同じ。迷ったら refuse
- "named_character": 既存のアニメ・ゲーム・漫画・映画などの特定キャラクターや作品（実写化・コスプレも同じ）
- "artist": 特定の写真家・作家・スタジオの作風の指定
- "image_input": ユーザーが手元の画像・写真を渡してそれを変換させる依頼（「この写真を」「添付の画像を元に」など）。「実写」「写真風」「リアル」などの画風の指定はこれに当たらない（実写モデルなのでそのまま描写する）
問題がなければ refuse は null。

出力形式（このJSONだけ）:
{"refuse": null | "adult" | "minor" | "real_person" | "named_character" | "artist" | "image_input", "reason": "断るときの日本語の一言（それ以外は空）", "tags": "…", "rating": "all_ages", "count": null | 1}`;
/** Photo model, r18 (only when the user picked R18): adults only. The Mac adds the adult-age positives and the
 *  minor-avoidance negatives itself; this prompt makes the AI write adults ("woman"/"man", never "girl"/"boy")
 *  and refuse anything that suggests youth, school or a real person. */
export const PHOTO_R18_SYSTEM_PROMPT = `あなたは画像生成プロンプトの変換係です。ユーザーの日本語の依頼を、実写系の画像生成モデル（RealVisXL）向けの英語の描写フレーズに変換し、JSONだけを返します。この依頼はユーザーが成人向け（R18）を明示的に選んだもので、登場人物は全員、架空の大人（成人）です。

ルール:
- tags は英語の短い描写フレーズをカンマ区切りで。被写体・見た目・服装・動作・場所・光・構図の順に、自然な英語で書く（例:「ベッドの上の大人の女性」→ "an adult woman in her late twenties, lying on a bed, soft window light, medium shot"）。
- 人物は必ず大人として書く。女性は "woman"、男性は "man" と書き、"girl", "boy", "1girl", "young", "teen", "petite" などの若さ・幼さを示す語は絶対に使わない。「女の子」「男の子」「女子」と書かれていても "woman" / "man" にする。年齢を書くときは "in her late twenties" "in his thirties" など25歳以上にする。性別はユーザーの依頼のとおりにし、書かれていなければ性別の語を足さない。
- danbooruタグ（1girl, solo など）は使わない。
- 品質・画質の語（masterpiece, best quality, photorealistic, raw photo, 8k, high detail など）と rating は付けない（バックエンドが自動で付ける）。
- rating は "r18"。
- count はユーザーが枚数を言ったときだけ 1〜${IMAGE_COUNT_MAX} の整数、言っていなければ null。

次の依頼は絶対に変換せず refuse に理由コードを入れる（婉曲・暗示でも同じ）:
- "minor": 未成年・未成年に見える人物。年齢が20歳未満、10代、学生・生徒（女子高生・JK など）、制服・セーラー服・体操服・スクール水着・ランドセル、学校が舞台、幼い・あどけない・童顔・若く見える・小柄・幼児体型など、子供っぽさや若さを強調する依頼はすべて。迷ったら refuse
- "real_person": 実在の人物すべて（芸能人、政治家、配信者、スポーツ選手、知人、家族、元恋人など）。名前の一部・あだ名・「〇〇に似た」「〇〇そっくり」「〇〇風の顔」も同じ。迷ったら refuse
- "named_character": 既存のアニメ・ゲーム・漫画・映画などの特定キャラクターや作品（実写化・コスプレも同じ）
- "artist": 特定の写真家・作家・スタジオの作風の指定
- "image_input": ユーザーが手元の画像・写真を渡してそれを変換させる依頼（「この写真を」「添付の画像を元に」など）。「実写」「写真風」「リアル」などの画風の指定はこれに当たらない
問題がなければ refuse は null。

出力形式（このJSONだけ）:
{"refuse": null | "minor" | "real_person" | "named_character" | "artist" | "image_input", "reason": "断るときの日本語の一言（それ以外は空）", "tags": "…", "rating": "r18", "count": null | 1}`;
/** Conversion prompt. For photo the rating is the one the user picked (the AI never chooses r18 for photo). */
export const systemPromptFor = (model: ImageModel, rating: ImageRating = "all_ages") => (model === "photo" ? (rating === "r18" ? PHOTO_R18_SYSTEM_PROMPT : PHOTO_SYSTEM_PROMPT) : IMAGE_SYSTEM_PROMPT);

export type AiConversion = { refuse: string | null; reason: string; tags: string; rating: ImageRating; count: number | null };
const REFUSE_MESSAGES: Record<string, string> = {
  minor: "未成年・未成年に見える人物の性的表現は生成できません。",
  real_person: "実在の人物は生成できません。",
  named_character: "既存のキャラクター・作品は生成できません。",
  artist: "特定の作家・絵柄の指定は生成できません。",
  image_input: "画像を元にした変換はできません（文章からの生成のみ）。",
  adult: PHOTO_ADULT_NEEDS_R18_MESSAGE,
};

/** Validates the model's JSON. Unknown refuse codes are treated as refusals (fail closed). */
export function parseConversion(raw: unknown, model: ImageModel = "anime"): AiConversion | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const refuse = o.refuse == null || o.refuse === "" || o.refuse === "null" || o.refuse === false ? null : String(o.refuse);
  const tags = normalizeTags(typeof o.tags === "string" ? o.tags : Array.isArray(o.tags) ? o.tags.map(String) : "", model);
  // For photo the AI's rating is ignored by the route (the user's explicit choice decides), so it is passed through as-is.
  const rating: ImageRating = o.rating === "r18" ? "r18" : "all_ages";
  const count = o.count == null ? null : clampCount(o.count, 1);
  return { refuse, reason: typeof o.reason === "string" ? o.reason.slice(0, 200) : "", tags, rating, count };
}
/** The AI sometimes reads style words like 実写/写真風 as image input. There is no upload, so only honour that refusal when the text asks for one. */
const I2I_HINT = /(画像|写真|絵|イラスト).{0,6}(を元|をもと|を参考|を変換|を加工)|添付|アップロード|この(画像|写真|絵)|img2img|i2i/i;
export const aiRefusal = (code: string | null, text: string) => (code === "image_input" && !I2I_HINT.test(text) ? null : code);
export const refuseMessage = (code: string, reason?: string) => REFUSE_MESSAGES[code] ?? (reason?.trim() || "この内容は生成できません。");

/** Final rating: r18 only when the user picked it, or when both the model and the user's own words say so. */
export function decideRating(requested: ImageRating | undefined, ai: ImageRating, text: string): ImageRating {
  if (requested === "r18") return "r18";
  if (requested === "all_ages") return "all_ages";
  return ai === "r18" && explicitlyAdult(text) ? "r18" : "all_ages";
}

/* ---------- service responses ---------- */

/** Message from a service error body: FastAPI puts it in {detail: {error, message}} or {detail: "…"}. */
export function serviceError(body: unknown): { error: string; message: string } {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (d && typeof d === "object") { const x = d as { error?: unknown; message?: unknown }; return { error: String(x.error ?? "error"), message: String(x.message ?? "") }; }
  if (typeof d === "string") return { error: "error", message: d };
  return { error: "error", message: "" };
}

/** Service filenames / work ids are restricted the same way the service restricts them. */
export const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
