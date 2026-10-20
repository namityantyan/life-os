import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { PageHeader, Card, Section, Stat, Badge, Button, PageSkeleton, EmptyState, Stagger, Item, cx } from "@/components/ui";
import { useApi, fmtDateTime, fmtNum } from "@/lib/api";

type Verdict = "success" | "warning" | "error" | "unknown";
type Run = { id: string; run_id: string; started_at: string | null; finished_at: string | null; duration_sec: number | null; personal_count: number | null; team_count: number | null; personal_bytes: number | null; team_bytes: number | null; errors: number; verdict: Verdict; verdict_label: string; summary: string | null; error_details: string[]; received_at: string };
type Latest = { latest: Run | null; stale: boolean; stale_hours: number; hours_since: number | null; endpoint: string; token_configured: boolean };
type ListRes = { runs: Run[]; page: number; page_size: number; total: number; pages: number };

const TONE: Record<Verdict, "green" | "orange" | "red" | "neutral"> = { success: "green", warning: "orange", error: "red", unknown: "neutral" };
const fmtBytes = (n: number | null) => { if (n == null) return "—"; const u = ["B", "KB", "MB", "GB", "TB"]; let v = n, i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`; };
const fmtDur = (s: number | null) => { if (s == null) return "—"; const r = Math.round(s); const h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), sec = r % 60; return h ? `${h}時間${m}分` : m ? `${m}分${sec}秒` : `${sec}秒`; };

export default function Page() {
  const [page, setPage] = useState(1);
  const latest = useApi<Latest>("/backups/latest", { poll: 60_000 });
  const list = useApi<ListRes>(`/backups?page=${page}`, { poll: 60_000 });
  if (latest.loading && !latest.data) return <PageSkeleton cards={3} />;
  const L = latest.data; const run = L?.latest ?? null;
  const error = latest.error ?? list.error;

  return (
    <div className="pb-10">
      <PageHeader title="バックアップ" subtitle="別PCのDropboxバックアップ結果を受信して表示します。実行・同期・削除は行いません。" />

      {error && (
        <div className="mb-5 rounded-[var(--radius-lg)] bg-red/10 text-red px-5 py-3 text-sm flex flex-wrap items-center gap-3" role="alert" data-testid="backup-error">
          <span>読み込みに失敗しました（{error}）</span>
          <Button size="sm" onClick={() => { latest.reload(); list.reload(); }}>再読み込み</Button>
        </div>
      )}

      {L?.stale && run && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="mb-5 rounded-[var(--radius-lg)] bg-orange/10 text-orange px-5 py-3 text-sm flex flex-wrap items-center gap-2" role="status" data-testid="backup-stale">
          <span className="font-medium">未受信</span>
          <span>最後の受信から{L.hours_since != null ? `約${Math.floor(L.hours_since)}時間` : `${L.stale_hours}時間以上`}経過しています。バックアップの失敗とは断定していません。別PCの実行ログと送信設定を確認してください。</span>
        </motion.div>
      )}

      <Section title="最新の結果">
        {run ? (
          <div data-testid="backup-latest"><Card>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <span data-testid="backup-latest-verdict"><Badge tone={TONE[run.verdict]} className="text-sm px-2.5 py-1">{run.verdict_label}</Badge></span>
              <span className="text-sm text-label-2">受信 {fmtDateTime(run.received_at)}</span>
              <span className="text-xs text-label-3 ml-auto tabular">実行ID {run.run_id}</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Stat label="開始" value={<span className="text-lg">{fmtDateTime(run.started_at)}</span>} />
              <Stat label="完了" value={<span className="text-lg">{fmtDateTime(run.finished_at)}</span>} />
              <Stat label="所要時間" value={fmtDur(run.duration_sec)} />
              <Stat label="エラー" value={run.errors} tone={run.errors ? "red" : undefined} />
              <Stat label="個人" value={run.personal_count == null ? "—" : `${fmtNum(run.personal_count)}件`} hint={fmtBytes(run.personal_bytes)} />
              <Stat label="チーム" value={run.team_count == null ? "—" : `${fmtNum(run.team_count)}件`} hint={fmtBytes(run.team_bytes)} />
            </div>
            {run.summary && <pre className="mt-4 text-xs text-label-2 whitespace-pre-wrap font-[inherit] bg-subtle rounded-[var(--radius-md)] px-4 py-3">{run.summary}</pre>}
            {run.error_details.length > 0 && <ul className="mt-3 text-xs text-red space-y-1">{run.error_details.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          </Card></div>
        ) : (
          <Card><EmptyState title="まだ結果を受信していません" hint="別PCの送信設定が完了すると、ここに最新の結果が表示されます。" /></Card>
        )}
      </Section>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr] mt-8">
        <Section title="履歴" action={list.data && <span className="text-xs text-label-3 tabular">{list.data.total}件（最大500件、30件ずつ）</span>}>
          {list.data && list.data.runs.length === 0 ? (
            <Card><EmptyState title="履歴はありません" /></Card>
          ) : (
            <>
              <Stagger className="space-y-2" key={page}>
                {list.data?.runs.map((r) => (
                  <Item key={r.id}>
                    <div data-testid={`backup-run-${r.run_id}`}><Card className="flex items-center gap-4">
                      <Badge tone={TONE[r.verdict]} className="shrink-0 w-20 justify-center">{r.verdict_label}</Badge>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium tabular">受信 {fmtDateTime(r.received_at)}<span className="text-label-3 font-normal ml-2">所要 {fmtDur(r.duration_sec)}</span></div>
                        <div className="text-xs text-label-2 mt-0.5 tabular truncate">個人 {r.personal_count == null ? "—" : `${fmtNum(r.personal_count)}件 / ${fmtBytes(r.personal_bytes)}`}　チーム {r.team_count == null ? "—" : `${fmtNum(r.team_count)}件 / ${fmtBytes(r.team_bytes)}`}{r.errors ? <span className="text-red ml-2">エラー {r.errors}</span> : null}</div>
                      </div>
                      <span className="text-xs text-label-3 tabular shrink-0 hidden md:inline">{r.run_id.slice(0, 18)}</span>
                    </Card></div>
                  </Item>
                ))}
              </Stagger>
              {list.data && list.data.pages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2 text-sm">
                  <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} data-testid="backup-page-prev">前へ</Button>
                  <span className="text-label-2 tabular">{page} / {list.data.pages}</span>
                  <Button size="sm" disabled={page >= list.data.pages} onClick={() => setPage((p) => p + 1)} data-testid="backup-page-next">次へ</Button>
                </div>
              )}
            </>
          )}
        </Section>

        <Section title="送信設定">
          <div data-testid="backup-settings"><Card className="space-y-3 text-sm">
            <div className="flex items-center justify-between"><span className="text-label-2">受信状態</span><Badge tone={L?.token_configured ? "green" : "orange"}>{L?.token_configured ? "受信可能" : "トークン未設定"}</Badge></div>
            <Row k="エンドポイント"><code className="text-xs">POST {L?.endpoint ?? "/api/integrations/backups"}</code></Row>
            <Row k="ヘッダー"><code className="text-xs">Authorization: Bearer ＜送信用トークン＞</code><br /><code className="text-xs">Content-Type: application/json</code></Row>
            <Row k="本文">
              <pre className="text-xs bg-subtle rounded-[var(--radius-md)] px-3 py-2 overflow-x-auto">{`{
  "run_id": "2026-10-20T02:00",
  "content": {
    "started_at": "…", "finished_at": "…",
    "duration_sec": 750,
    "personal": { "count": 0, "bytes": 0 },
    "team": { "count": 0, "bytes": 0 },
    "errors": 0,
    "verdict": "success | warning | error"
  }
}`}</pre>
            </Row>
            <Row k="応答"><span className="tabular">新規 201 ／ 同じ実行IDの再送 200 ／ 認証失敗 401</span></Row>
            <p className={cx("text-xs text-label-3 pt-1")}>トークンはサーバー側の環境変数 BACKUP_INGEST_TOKEN に保管し、この画面には表示しません。再発行した場合は別PC側の設定も更新してください。受信から{L?.stale_hours ?? 36}時間を超えると「未受信」と表示します。</p>
          </Card></div>
        </Section>
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return <div><div className="text-xs text-label-2 font-medium mb-1">{k}</div><div>{children}</div></div>;
}
