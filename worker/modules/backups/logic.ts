/** Pure helpers for backup receipts: payload normalization, verdict, staleness. */

export const STALE_HOURS = 36;
export const MAX_RUNS_PER_USER = 500;
export const PAGE_SIZE = 30;

export type Verdict = "success" | "warning" | "error" | "unknown";

export type NormalizedRun = {
  started_at: string | null; finished_at: string | null; duration_sec: number | null;
  personal_count: number | null; personal_bytes: number | null; team_count: number | null; team_bytes: number | null;
  errors: number; verdict: Verdict; summary: string | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const isoOrNull = (v: unknown): string | null => { const s = str(v); if (!s) return null; const t = Date.parse(s); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

export function normalizeVerdict(v: unknown): Verdict | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["success", "ok", "succeeded", "pass", "passed", "成功", "正常"].includes(s)) return "success";
  if (["warning", "warn", "warned", "注意", "警告"].includes(s)) return "warning";
  if (["error", "fail", "failed", "failure", "ng", "失敗", "エラー"].includes(s)) return "error";
  if (["unknown", "不明"].includes(s)) return "unknown";
  return null;
}

/** Read an explicit 「判定: OK / WARN / NG」 line from a free-text summary; `完了` alone is not success. */
export function verdictFromText(text: string | null | undefined): Verdict | null {
  if (!text) return null;
  const m = text.match(/判定\s*[:：]\s*([A-Za-z]+|成功|失敗|注意|警告|不明|正常|エラー)/) ?? text.match(/\b(status|verdict)\s*[:：]\s*([A-Za-z]+)/i);
  if (!m) return null;
  return normalizeVerdict(m[2] ?? m[1]);
}

/**
 * Normalize the `content` object (or legacy summary string) of a receipt.
 * Accepts {started_at, finished_at|completed_at, duration_sec|duration_seconds, personal:{count|files,bytes}, team:{…}, errors|error_count, verdict|status, summary|text}.
 * Rule: errors ≥ 1 forces verdict to error even if the sender said success.
 */
export function normalizeRun(content: unknown): NormalizedRun {
  if (typeof content === "string") {
    return { started_at: null, finished_at: null, duration_sec: null, personal_count: null, personal_bytes: null, team_count: null, team_bytes: null, errors: 0, verdict: verdictFromText(content) ?? "unknown", summary: content.trim() || null };
  }
  const c = (content && typeof content === "object" ? content : {}) as Record<string, unknown>;
  const group = (g: unknown) => { const o = (g && typeof g === "object" ? g : {}) as Record<string, unknown>; return { count: num(o.count) ?? num(o.files), bytes: num(o.bytes) }; };
  const personal = group(c.personal); const team = group(c.team);
  const errorsRaw = num(c.errors) ?? num(c.error_count) ?? (Array.isArray(c.errors) ? c.errors.length : 0) ?? 0;
  const errors = Math.max(0, Math.floor(errorsRaw ?? 0));
  const summary = str(c.summary) ?? str(c.text) ?? str(c.message);
  let verdict: Verdict = normalizeVerdict(c.verdict) ?? normalizeVerdict(c.status) ?? verdictFromText(summary) ?? "unknown";
  if (errors > 0 && verdict !== "error") verdict = "error";
  const started_at = isoOrNull(c.started_at); const finished_at = isoOrNull(c.finished_at) ?? isoOrNull(c.completed_at);
  let duration_sec = num(c.duration_sec) ?? num(c.duration_seconds);
  if (duration_sec == null && started_at && finished_at) duration_sec = Math.max(0, (Date.parse(finished_at) - Date.parse(started_at)) / 1000);
  return { started_at, finished_at, duration_sec, personal_count: personal.count, personal_bytes: personal.bytes, team_count: team.count, team_bytes: team.bytes, errors, verdict, summary };
}

/** 36h without a receipt = stale. Stale is "未受信", explicitly not a failure. */
export function isStale(lastReceivedIso: string | null | undefined, now: number = Date.now(), hours = STALE_HOURS): boolean {
  if (!lastReceivedIso) return true;
  const t = Date.parse(lastReceivedIso);
  if (Number.isNaN(t)) return true;
  return now - t > hours * 3600_000;
}

export function hoursSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null; const t = Date.parse(iso); if (Number.isNaN(t)) return null;
  return Math.max(0, (now - t) / 3600_000);
}

export const VERDICT_LABELS: Record<Verdict, string> = { success: "成功", warning: "注意", error: "失敗", unknown: "結果を確認" };

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"]; let v = n; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.round(sec); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  if (h) return `${h}時間${m}分`; if (m) return `${m}分${r}秒`; return `${r}秒`;
}
