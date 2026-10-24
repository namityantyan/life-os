// 画像生成 (images module): types shared by the Worker API and the React frontend.

export const IMAGE_RATINGS = ["all_ages", "r18"] as const;
export type ImageRating = (typeof IMAGE_RATINGS)[number];
export const IMAGE_RATING_LABELS: Record<ImageRating, string> = { all_ages: "全年齢", r18: "R18" };
export const IMAGE_COUNT_MAX = 4;

export type ImageGenStatus = "queued" | "running" | "done" | "error";
export const IMAGE_STATUS_LABELS: Record<ImageGenStatus, string> = { queued: "待機中", running: "生成中", done: "完了", error: "失敗" };

export type ImageFile = { id: string; idx: number; filename: string; seed: number | null; bytes: number; created_at: string };
export type ImageGeneration = {
  id: string; prompt_text: string; tags: string; rating: ImageRating; count: number; seed: number | null;
  status: ImageGenStatus; progress_done: number; queue_position: number | null; error: string | null;
  created_at: string; updated_at: string; files: ImageFile[];
};

/** GET /api/images/status. `state`: online = can generate; offline = configured but the Mac is unreachable
 *  or not ready; unconfigured = IMGGEN_URL / IMGGEN_TOKEN not set on this server. */
export type ImageServiceStatus = {
  state: "online" | "offline" | "unconfigured";
  message: string | null;
  comfyui: "up" | "down" | null; model_available: boolean | null; queue_length: number | null;
};
