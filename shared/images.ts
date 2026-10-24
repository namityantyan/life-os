// 画像生成 (images module): types shared by the Worker API and the React frontend.

export const IMAGE_RATINGS = ["all_ages", "r18"] as const;
export type ImageRating = (typeof IMAGE_RATINGS)[number];
export const IMAGE_RATING_LABELS: Record<ImageRating, string> = { all_ages: "全年齢", r18: "R18" };
export const IMAGE_COUNT_MAX = 4;

/** Which checkpoint the Mac uses: anime = Animagine XL 4.0 (default), photo = RealVisXL V5.0 (photoreal, all-ages only). */
export const IMAGE_MODELS = ["anime", "photo"] as const;
export type ImageModel = (typeof IMAGE_MODELS)[number];
export const IMAGE_MODEL_LABELS: Record<ImageModel, string> = { anime: "アニメ", photo: "実写" };
export const asImageModel = (v: unknown): ImageModel => (v === "photo" ? "photo" : "anime");
export const PHOTO_R18_MESSAGE = "実写モデルは全年齢のみです。R18・成人向けの実写は生成できません（アニメを選んでください）。";

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
