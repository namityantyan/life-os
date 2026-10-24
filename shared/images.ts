// 画像生成 (images module): types shared by the Worker API and the React frontend.

export const IMAGE_RATINGS = ["all_ages", "r18"] as const;
export type ImageRating = (typeof IMAGE_RATINGS)[number];
export const IMAGE_RATING_LABELS: Record<ImageRating, string> = { all_ages: "全年齢", r18: "R18" };
export const IMAGE_COUNT_MAX = 4;

/** Which checkpoint the Mac uses: anime = Animagine XL 4.0 (default), photo = RealVisXL V5.0 (photoreal).
 *  Photo r18 is allowed only when chosen explicitly, adults only (adult positives + minor-avoidance negatives on the Mac,
 *  youth/school/age words refused), and real people are refused for photo at every rating. */
export const IMAGE_MODELS = ["anime", "photo"] as const;
export type ImageModel = (typeof IMAGE_MODELS)[number];
export const IMAGE_MODEL_LABELS: Record<ImageModel, string> = { anime: "アニメ", photo: "実写" };
export const asImageModel = (v: unknown): ImageModel => (v === "photo" ? "photo" : "anime");
/** Photo + all-ages + sexual / adult words. */
export const PHOTO_ADULT_NEEDS_R18_MESSAGE = "実写の全年齢では性的・成人向けの表現は生成できません。成人向けにするときは区分で「R18」を選んでください。";
/** Photo + r18 + an age / youth / school word. */
export const PHOTO_R18_YOUTH_MESSAGE = "実写のR18は大人（成人）だけです。年齢・学生・制服・幼さを示す言葉は使えません。";

export type ImageGenStatus = "queued" | "running" | "done" | "error";
export const IMAGE_STATUS_LABELS: Record<ImageGenStatus, string> = { queued: "待機中", running: "生成中", done: "完了", error: "失敗" };

export type ImageFile = { id: string; idx: number; filename: string; seed: number | null; bytes: number; created_at: string };
export type ImageGeneration = {
  id: string; prompt_text: string; tags: string; model: ImageModel; rating: ImageRating; count: number; seed: number | null;
  status: ImageGenStatus; progress_done: number; queue_position: number | null; error: string | null;
  created_at: string; updated_at: string; files: ImageFile[];
};

/** GET /api/images/status. `state`: online = can generate; offline = configured but the Mac is unreachable
 *  or not ready; unconfigured = IMGGEN_URL / IMGGEN_TOKEN not set on this server.
 *  `models`: which checkpoints the Mac has installed (null when unknown; an older service without the field = anime only). */
export type ImageServiceStatus = {
  state: "online" | "offline" | "unconfigured";
  message: string | null;
  comfyui: "up" | "down" | null; model_available: boolean | null; queue_length: number | null;
  models: Record<ImageModel, boolean> | null;
};
