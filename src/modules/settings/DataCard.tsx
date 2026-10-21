import { useRef, useState } from "react";
import { api, useApi, fmtNum } from "@/lib/api";
import { Badge, Button, Card, Input, Modal, Segmented, Skeleton, useToast } from "@/components/ui";

type Stats = { counts: Record<string, number>; total: number; size_bytes_estimate: number; tables: string[] };
type ImportResult = { ok: boolean; mode: string; inserted: Record<string, number>; deleted: Record<string, number>; skipped: string[]; total: number };

const TABLE_LABELS: Record<string, string> = {
  settings: "設定", notifications: "通知", planner_items: "予定・タスク", ideas: "アイデア", notes: "メモ",
  oura_daily: "Oura 日次", meal_routines: "食事セットの中身", meal_foods: "よく食べるもの", meal_sets: "食事セット", meal_entries: "食事の記録", beauty_routines: "美容ルーティン", checkups: "健診", pressure_logs: "気圧の体調ログ", chat_messages: "相談ログ",
  training_sessions: "トレーニング", training_sets: "セット", asset_accounts: "資産口座", asset_balances: "残高履歴", card_transactions: "カード明細", card_statements: "カード請求",
  fx_connector_state: "FX接続状態", fx_signals: "FXシグナル", fx_trades: "FX取引", fx_trade_events: "FX取引イベント", invoices: "請求書", royalty_mails: "著作権明細メール",
  backup_runs: "バックアップ履歴", requests: "リクエスト", discord_links: "Discord連携", discord_channels: "Discordチャンネル",
};
const label = (t: string) => TABLE_LABELS[t] ?? t;
const fmtBytes = (b: number) => b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${fmtNum(b / 1024, 1)} KB` : `${fmtNum(b / 1024 / 1024, 2)} MB`;

async function download(path: string, filename: string) {
  const res = await fetch(`/api${path}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`書き出しに失敗しました（${res.status}）`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function DataCard() {
  const { data, loading, reload } = useApi<Stats>("/data/stats");
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState<"json" | "md" | null>(null);
  const [preview, setPreview] = useState<{ name: string; tables: Record<string, unknown[]>; exported_at?: string; unknown: string[] } | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [confirmText, setConfirmText] = useState("");
  const [importing, setImporting] = useState(false);
  const day = new Date().toISOString().slice(0, 10);

  const doExport = async (kind: "json" | "md") => {
    setExporting(kind);
    try {
      if (kind === "json") await download("/data/export", `life-os-export-${day}.json`);
      else await download("/data/export/notes.md", `life-os-notes-${day}.md`);
      toast("書き出しました", "success");
    } catch (e: any) { toast(e?.message ?? "書き出しに失敗しました", "error"); }
    finally { setExporting(null); }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      const tables = (json && typeof json === "object" && json.tables && typeof json.tables === "object") ? json.tables : json;
      if (!tables || typeof tables !== "object" || Array.isArray(tables)) throw new Error("形式が違います");
      const known = new Set(data?.tables ?? Object.keys(TABLE_LABELS));
      const picked: Record<string, unknown[]> = {}; const unknown: string[] = [];
      for (const [k, v] of Object.entries(tables)) { if (!Array.isArray(v)) continue; if (known.has(k)) picked[k] = v; else unknown.push(k); }
      setPreview({ name: f.name, tables: picked, exported_at: typeof json.exported_at === "string" ? json.exported_at : undefined, unknown });
      setMode("merge"); setConfirmText("");
    } catch (e: any) { toast(e?.message ?? "ファイルを読めませんでした", "error"); }
    finally { if (fileRef.current) fileRef.current.value = ""; }
  };

  const doImport = async () => {
    if (!preview) return;
    setImporting(true);
    try {
      const r = await api.post<ImportResult>("/data/import", { mode, data: preview.tables });
      toast(`${fmtNum(r.total)}件を読み込みました`, "success");
      setPreview(null); reload(true);
    } catch (e: any) { toast(e?.message ?? "読み込みに失敗しました", "error"); }
    finally { setImporting(false); }
  };

  const previewTotal = preview ? Object.values(preview.tables).reduce((a, v) => a + v.length, 0) : 0;
  const canImport = preview && previewTotal > 0 && (mode === "merge" || confirmText.trim() === "置き換え");

  return (
    <Card className="space-y-4" data-testid="data-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">書き出しと読み込み</div>
          <p className="text-xs text-label-2 mt-1">すべてのモジュールの記録をJSONで保存・復元します。接続の鍵や端末登録は含みません。</p>
        </div>
        {data && <span data-testid="data-total"><Badge>{fmtNum(data.total)}件 · 約{fmtBytes(data.size_bytes_estimate)}</Badge></span>}
      </div>

      <div className="flex gap-2 flex-wrap">
        <Button variant="primary" onClick={() => doExport("json")} loading={exporting === "json"} data-testid="export-json">JSONを書き出す</Button>
        <Button onClick={() => doExport("md")} loading={exporting === "md"} data-testid="export-notes-md">メモをMarkdownで書き出す</Button>
        <Button variant="tinted" onClick={() => fileRef.current?.click()} data-testid="import-open">読み込む</Button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} data-testid="import-file" />
      </div>

      {loading && !data && <Skeleton className="h-40" />}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-sm" data-testid="data-counts">
          {data.tables.map((t) => (
            <div key={t} className="flex items-center justify-between py-1 border-b border-separator/60">
              <span className="text-label-2 truncate">{label(t)}</span>
              <span className={data.counts[t] ? "tabular" : "tabular text-label-3"}>{fmtNum(data.counts[t])}</span>
            </div>
          ))}
        </div>
      )}

      <Modal open={Boolean(preview)} onClose={() => !importing && setPreview(null)} title="データを読み込む"
        footer={<><Button variant="ghost" onClick={() => setPreview(null)} disabled={importing}>キャンセル</Button><Button variant={mode === "replace" ? "danger" : "primary"} onClick={doImport} disabled={!canImport} loading={importing} data-testid="import-confirm">{mode === "replace" ? "置き換えて読み込む" : "読み込む"}</Button></>}>
        {preview && (
          <div className="space-y-4">
            <div className="text-sm text-label-2">{preview.name}{preview.exported_at && <> · 書き出し {preview.exported_at.slice(0, 16).replace("T", " ")}</>}</div>
            <div className="max-h-56 overflow-auto rounded-[var(--radius-md)] bg-fill p-3 text-sm space-y-1" data-testid="import-preview">
              {Object.entries(preview.tables).filter(([, v]) => v.length > 0).map(([t, v]) => (
                <div key={t} className="flex justify-between"><span>{label(t)}</span><span className="tabular">{fmtNum(v.length)}</span></div>
              ))}
              {previewTotal === 0 && <div className="text-label-3 text-center py-4">読み込める行がありません</div>}
              {preview.unknown.length > 0 && <div className="text-xs text-label-3 pt-2">無視: {preview.unknown.join(", ")}</div>}
            </div>
            <div className="space-y-2">
              <Segmented testId="import-mode" value={mode} onChange={setMode} options={[{ value: "merge", label: "追加（既存は残す）" }, { value: "replace", label: "置き換え" }]} />
              <p className="text-xs text-label-2">{mode === "merge" ? "同じIDの行は読み込まず、ない行だけ追加します。" : "ファイルに含まれる種類の既存データをすべて削除してから読み込みます。取り消せません。"}</p>
            </div>
            {mode === "replace" && (
              <label className="block space-y-1.5"><span className="text-xs font-medium text-red">確認のため「置き換え」と入力</span>
                <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="置き換え" data-testid="import-confirm-text" /></label>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}
