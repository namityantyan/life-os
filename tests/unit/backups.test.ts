import { describe, it, expect } from "vitest";
import { normalizeRun, isStale, hoursSince, verdictFromText, formatBytes, formatDuration } from "../../worker/modules/backups/logic";

describe("normalizeRun", () => {
  it("reads the structured content shape", () => {
    const n = normalizeRun({ started_at: "2026-10-20T02:00:00+09:00", finished_at: "2026-10-20T02:12:30+09:00", duration_sec: 750, personal: { count: 1200, bytes: 5_000_000 }, team: { count: 30, bytes: 1000 }, errors: 0, verdict: "success" });
    expect(n.verdict).toBe("success"); expect(n.duration_sec).toBe(750); expect(n.personal_count).toBe(1200); expect(n.team_bytes).toBe(1000);
    expect(n.started_at).toBe("2026-10-19T17:00:00.000Z");
  });
  it("accepts legacy aliases (completed_at, duration_seconds, files, error_count, status)", () => {
    const n = normalizeRun({ started_at: "2026-10-20T02:00:00Z", completed_at: "2026-10-20T02:10:00Z", personal: { files: 5, bytes: 10 }, error_count: 0, status: "warning" });
    expect(n.verdict).toBe("warning"); expect(n.duration_sec).toBe(600); expect(n.personal_count).toBe(5);
  });
  it("forces error when errors >= 1 even if verdict says success", () => {
    expect(normalizeRun({ verdict: "success", errors: 2 }).verdict).toBe("error");
  });
  it("reads 判定 from a plain summary string, 完了 alone is unknown", () => {
    expect(normalizeRun("Dropbox バックアップ結果\n判定: OK").verdict).toBe("success");
    expect(normalizeRun("判定: NG").verdict).toBe("error");
    expect(normalizeRun("バックアップ完了").verdict).toBe("unknown");
    expect(verdictFromText("判定: WARN")).toBe("warning");
  });
  it("defaults missing values to null rather than 0", () => {
    const n = normalizeRun({});
    expect(n.personal_count).toBeNull(); expect(n.duration_sec).toBeNull(); expect(n.errors).toBe(0); expect(n.verdict).toBe("unknown");
  });
});

describe("staleness", () => {
  const now = Date.parse("2026-10-21T00:00:00Z");
  it("is stale beyond 36h, fresh within", () => {
    expect(isStale("2026-10-19T11:00:00Z", now)).toBe(true);  // 37h
    expect(isStale("2026-10-19T13:00:00Z", now)).toBe(false); // 35h
    expect(isStale(null, now)).toBe(true);
    expect(isStale("garbage", now)).toBe(true);
  });
  it("hoursSince", () => { expect(hoursSince("2026-10-20T12:00:00Z", now)).toBe(12); expect(hoursSince(null, now)).toBeNull(); });
});

describe("formatting", () => {
  it("formatBytes", () => { expect(formatBytes(0)).toBe("0 B"); expect(formatBytes(1536)).toBe("1.5 KB"); expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB"); expect(formatBytes(null)).toBe("—"); });
  it("formatDuration", () => { expect(formatDuration(45)).toBe("45秒"); expect(formatDuration(750)).toBe("12分30秒"); expect(formatDuration(3660)).toBe("1時間1分"); expect(formatDuration(null)).toBe("—"); });
});
