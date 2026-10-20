import { useEffect, useState } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";
import { PageHeader, PageSkeleton, Card, Section, Stat, Badge, Button, Input, Select, Field, Textarea, Modal, EmptyState, ErrorBanner, Stagger, Item, ChatPanel, ChartTip, useChartColors, useToast, cx, type ChatMsg } from "@/components/ui";
import { api, useApi, fmtYen, fmtDateTime, todayJst } from "@/lib/api";
import type { CardOverview, CardStatement, CardSettings } from "@shared/cards";

const fmtMan = (v: number) => (Math.abs(v) >= 10000 ? `${(v / 10000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}万` : v.toLocaleString("ja-JP"));
const fmtD = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
type Insights = { month: string; merchants: { merchant: string; total: number; count: number }[]; categories: { category: string; total: number }[]; pace_month_end: number | null; prev_month: { month: string; total: number }; candidates: { label: string; detail: string; amount: number }[] };

export default function Page() {
  const toast = useToast();
  const ov = useApi<CardOverview>("/cards/overview", { poll: 60_000 });
  const statements = useApi<{ statements: CardStatement[] }>("/cards/statements");
  const insights = useApi<Insights>("/cards/insights");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [txOpen, setTxOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const cc = useChartColors();
  const reload = () => { ov.reload(true); statements.reload(true); insights.reload(true); };
  const gmailSync = async () => { setSyncing(true); try { const r = await api.post<{ connected: boolean; found: number; imported: number; errors: string[] }>("/cards/gmail/sync"); toast(r.connected ? `Gmailを確認しました（${r.found}件中 新規${r.imported}件）` : "Gmailは未接続です（設定からGoogle連携でgmail.readonlyを許可してください）", r.connected ? "success" : "error"); reload(); } catch (e: any) { toast(e.message, "error"); } finally { setSyncing(false); } };
  if (ov.loading && !ov.data) return <PageSkeleton />;
  if (!ov.data) return <div><PageHeader title="カード利用" /><ErrorBanner message={ov.error} onRetry={() => ov.reload()} testId="cards-error" /><EmptyState title="カード利用を取得できません" /></div>;
  const o = ov.data;
  const g = o.guide;
  return (
    <div>
      <PageHeader title="カード利用" subtitle="三井住友カードの利用通知と確定明細。速報であり確定請求ではありません。" actions={<><Button onClick={gmailSync} loading={syncing} data-testid="gmail-sync">Gmailを確認</Button><Button onClick={() => setSettingsOpen(true)} data-testid="settings-open">設定</Button><Button variant="primary" onClick={() => setTxOpen(true)} data-testid="tx-add">利用を追加</Button></>} />
      {(ov.error || statements.error || insights.error) && <ErrorBanner message={ov.error ?? statements.error ?? insights.error} onRetry={reload} testId="cards-error" />}
      <Card className="mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-5" data-testid="card-stats">
          <Stat label="今月の利用累計" value={fmtYen(o.month_total)} hint={`${o.month} 取得済み ${o.count}件`} />
          <Stat label="月予算の残り" value={o.budget_left == null ? "—" : fmtYen(o.budget_left)} hint={o.budget == null ? "予算が未設定です" : `予算 ${fmtYen(o.budget)}`} tone={o.budget_left != null && o.budget_left < 0 ? "red" : undefined} />
          <Stat label="今月の支払い" value={o.statement ? fmtYen(o.statement.amount) : "—"} hint={o.statement ? `${o.statement.billing_month}分・引落 ${o.statement.debit_date ?? "未定"}${o.statement.confirmed ? "" : "・未確認"}` : "確定明細が未登録です"} />
          <Stat label="追加利用の目安" value={g.undetermined ? "保留" : fmtYen(g.amount)} hint={g.undetermined ? g.reason : `現金から見た上限 ${fmtYen(g.cash_cap)}・残高 ${o.cash.as_of ?? "—"} 時点`} tone={g.undetermined ? "orange" : "accent"} />
        </div>
      </Card>
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Section title="今月の利用累計">
            <Card>
              <div className="text-xs text-label-2 mb-2">利用期間（{o.month}-01 〜 {o.today}）のみ。支払日まで延ばしません。口座残高や総資産ではありません。</div>
              <div className="h-56" data-testid="card-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={o.series} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke={cc.separator} />
                    <XAxis dataKey="date" tickFormatter={fmtD} tick={{ fill: cc.label2, fontSize: cc.tickFont }} axisLine={false} tickLine={false} minTickGap={24} />
                    <YAxis tickFormatter={fmtMan} tick={{ fill: cc.label2, fontSize: cc.tickFont }} axisLine={false} tickLine={false} width={40} />
                    {o.budget != null && <ReferenceLine y={o.budget} stroke={cc.label3} strokeDasharray="4 4" label={{ value: "予算", position: "insideTopRight", fill: cc.label2, fontSize: cc.tickFont }} />}
                    <Tooltip cursor={{ stroke: cc.label3 }} content={({ active, payload }) => active && payload?.[0] ? <ChartTip label={fmtD((payload[0].payload as any).date)} value={fmtYen(payload[0].value as number)} /> : null} />
                    <Line type="stepAfter" dataKey="cumulative" stroke={cc.accent} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: cc.elevated }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </Section>
          <Section title="利用タイムライン">
            {o.timeline.length === 0 ? <Card><EmptyState title="今月の利用はまだありません" hint="Gmailを確認するか、手動で追加できます" /></Card> : (
              <Stagger className="card divide-y divide-separator">
                {o.timeline.map((t) => (
                  <Item key={t.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1"><div className="font-medium truncate" data-testid="tx-merchant">{t.merchant ?? "（利用先なし）"}{t.status === "cancelled" && <Badge tone="red" className="ml-2">取消</Badge>}{t.status === "confirmed" && <Badge tone="green" className="ml-2">確定</Badge>}</div><div className="text-xs text-label-2">{fmtDateTime(t.used_at)}・{t.source === "gmail" ? "メール" : t.source === "csv" ? "明細" : "手入力"}</div></div>
                    <div className="text-right"><div className={cx("tabular font-medium", t.status === "cancelled" && "line-through text-label-3")}>{fmtYen(t.amount)}</div><div className="text-xs text-label-2 tabular">累計 {fmtYen(t.running)}</div></div>
                    <Button size="sm" variant="danger" aria-label={`${t.merchant ?? "利用"}を削除`} onClick={async () => { if (!confirm(`「${t.merchant ?? "利用先なし"} ${fmtYen(t.amount)}」を削除しますか？`)) return; await api.del(`/cards/transactions/${t.id}`); reload(); }}>削除</Button>
                  </Item>
                ))}
              </Stagger>
            )}
          </Section>
        </div>
        <div className="space-y-6">
          <StatementsSection statements={statements.data?.statements ?? []} onChanged={reload} />
          <Section title="見直し候補">
            <Card>
              {!insights.data ? null : insights.data.candidates.length === 0 && insights.data.merchants.length === 0 ? <div className="text-sm text-label-3">今月のデータがまだ少ないため候補はありません。</div> : (
                <div className="space-y-3 text-sm">
                  {insights.data.candidates.map((c, i) => <div key={i}><div className="font-medium">{c.label}</div><div className="text-xs text-label-2">{c.detail}</div></div>)}
                  {insights.data.merchants.length > 0 && <div><div className="text-xs text-label-2 mb-1">利用先の上位</div>{insights.data.merchants.slice(0, 5).map((m) => <div key={m.merchant} className="flex justify-between gap-3"><span className="truncate min-w-0">{m.merchant} <span className="text-label-3 tabular">×{m.count}</span></span><span className="tabular text-right shrink-0">{fmtYen(m.total)}</span></div>)}</div>}
                  {insights.data.pace_month_end != null && <div className="text-xs text-label-2">このペースの月末見込み {fmtYen(insights.data.pace_month_end)}・先月 {fmtYen(insights.data.prev_month.total)}</div>}
                </div>
              )}
            </Card>
          </Section>
          <Section title="FP相談"><Card className="h-[28rem]"><Chat /></Card></Section>
        </div>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={reload} notified={o.notified_unpaid} />
      <TxModal open={txOpen} onClose={() => setTxOpen(false)} onSaved={reload} />
    </div>
  );
}

function SettingsModal({ open, onClose, onSaved, notified }: { open: boolean; onClose: () => void; onSaved: () => void; notified: number }) {
  const toast = useToast();
  const [s, setS] = useState<CardSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) api.get<CardSettings>("/cards/settings").then(setS).catch((e: any) => toast(e.message, "error")); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = (v: string) => (v === "" ? null : Number(v));
  const save = async () => { setSaving(true); try { await api.put("/cards/settings", s); toast("設定を保存しました", "success"); onSaved(); onClose(); } catch (e: any) { toast(e.message, "error"); } finally { setSaving(false); } };
  return (
    <Modal open={open} onClose={onClose} title="カード設定" footer={<><Button onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={save} disabled={!s} loading={saving} data-testid="settings-save">保存</Button></>}>
      {s && <div className="grid grid-cols-2 gap-3">
        <Field label="月予算（円）"><Input inputMode="numeric" value={s.monthly_budget ?? ""} onChange={(e) => setS({ ...s, monthly_budget: n(e.target.value) })} data-testid="settings-budget" /></Field>
        <Field label="確保する現金（円）"><Input inputMode="numeric" value={s.reserve_cash ?? ""} onChange={(e) => setS({ ...s, reserve_cash: n(e.target.value) })} /></Field>
        <Field label="確認済みの未払いカード額（円）" hint={`引落済みの明細より後の通知額 ${fmtYen(notified)} 以上で確認`}><Input inputMode="numeric" value={s.unpaid_confirmed ?? ""} onChange={(e) => setS({ ...s, unpaid_confirmed: n(e.target.value) })} /></Field>
        <Field label="次回の賞与予定日"><Input type="date" value={s.next_bonus_date ?? ""} onChange={(e) => setS({ ...s, next_bonus_date: e.target.value || null })} /></Field>
      </div>}
    </Modal>
  );
}

function TxModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ date: todayJst(), time: "12:00", merchant: "", amount: "", category: "" });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try { await api.post("/cards/transactions", { used_at: `${f.date}T${f.time}:00+09:00`, merchant: f.merchant || null, amount: Number(f.amount), category: f.category || null }); toast("追加しました", "success"); onSaved(); onClose(); setF({ ...f, merchant: "", amount: "" }); }
    catch (e: any) { toast(e.message, "error"); } finally { setSaving(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="利用を追加" footer={<><Button onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={save} disabled={!f.amount} loading={saving} data-testid="tx-submit">追加</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="利用日"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="時刻"><Input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
        <Field label="利用先" className="col-span-2"><Input value={f.merchant} onChange={(e) => setF({ ...f, merchant: e.target.value })} data-testid="tx-merchant-input" /></Field>
        <Field label="金額（円）"><Input inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} data-testid="tx-amount-input" /></Field>
        <Field label="分類（任意）"><Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="食費、交通 など" /></Field>
      </div>
    </Modal>
  );
}

function StatementsSection({ statements, onChanged }: { statements: CardStatement[]; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"manual" | "csv">("manual");
  const [f, setF] = useState({ billing_month: todayJst().slice(0, 7), amount: "", debit_date: "", csv: "" });
  const [preview, setPreview] = useState<{ valid: boolean; total: number | null; lines_total: number; lines: unknown[]; errors: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const check = async () => { try { setPreview(await api.post("/cards/import/csv", { csv: f.csv, billing_month: f.billing_month, debit_date: f.debit_date || null, dry_run: true })); } catch (e: any) { setPreview(e.detail ?? { valid: false, total: null, lines_total: 0, lines: [], errors: [e.message] }); } };
  const save = async () => {
    setSaving(true);
    try {
      if (mode === "csv") await api.post("/cards/import/csv", { csv: f.csv, billing_month: f.billing_month, debit_date: f.debit_date || null });
      else await api.post("/cards/statements", { billing_month: f.billing_month, amount: Number(f.amount), debit_date: f.debit_date || null, confirmed: true });
      toast("明細を登録しました", "success"); setOpen(false); setPreview(null); onChanged();
    } catch (e: any) { toast(e.message, "error"); } finally { setSaving(false); }
  };
  const patch = async (s: CardStatement, body: Partial<{ confirmed: boolean; paid: boolean; debit_date: string | null }>) => { await api.put(`/cards/statements/${s.id}`, body); onChanged(); };
  return (
    <Section title="確定明細と支払日" action={<Button size="sm" onClick={() => setOpen(true)} data-testid="statement-add">明細を登録</Button>}>
      {statements.length === 0 ? <Card><EmptyState title="確定明細がありません" hint="CSVを取り込むか、請求額と引落日を登録します" /></Card> : (
        <Card padded={false}><div className="divide-y divide-separator">
          {statements.map((s) => (
            <div key={s.id} className="px-5 py-3 space-y-2" data-testid="statement-row">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium tabular whitespace-nowrap">{s.billing_month}分 {fmtYen(s.amount)}</span>
                {s.paid ? <Badge tone="green">引落済み</Badge> : s.confirmed ? <Badge tone="accent">確認済み</Badge> : <Badge tone="orange">未確認</Badge>}
                {s.line_count != null && <span className="text-xs text-label-2">{s.line_count}行</span>}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-xs text-label-2">
                <span>引落日</span><Input type="date" className="h-9 w-40 text-sm" value={s.debit_date ?? ""} onChange={(e) => patch(s, { debit_date: e.target.value || null })} aria-label={`${s.billing_month}分の引落日`} />
                <span className="flex-1" />
                {!s.confirmed && <Button size="sm" onClick={() => patch(s, { confirmed: true })} data-testid="statement-confirm">確認</Button>}
                {s.confirmed && !s.paid && <Button size="sm" onClick={() => patch(s, { paid: true })}>引落済みにする</Button>}
                <Button size="sm" variant="danger" onClick={async () => { if (!confirm(`${s.billing_month}分の明細を削除しますか？CSVの明細行も削除されます。`)) return; await api.del(`/cards/statements/${s.id}`); onChanged(); }}>削除</Button>
              </div>
            </div>
          ))}
        </div></Card>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="確定明細を登録" wide={mode === "csv"} footer={<><Button onClick={() => setOpen(false)}>キャンセル</Button>{mode === "csv" && <Button onClick={check} disabled={!f.csv.trim()}>検証</Button>}<Button variant="primary" onClick={save} disabled={mode === "csv" ? !f.csv.trim() : !f.amount} loading={saving} data-testid="statement-submit">登録</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="登録方法" className="col-span-2"><Select value={mode} onChange={(e) => setMode(e.target.value as "manual" | "csv")}><option value="manual">請求額を入力</option><option value="csv">CSV明細を取り込む</option></Select></Field>
          <Field label="請求月"><Input type="month" value={f.billing_month} onChange={(e) => setF({ ...f, billing_month: e.target.value })} data-testid="statement-month" /></Field>
          <Field label="引落日（実際の日付）"><Input type="date" value={f.debit_date} onChange={(e) => setF({ ...f, debit_date: e.target.value })} /></Field>
          {mode === "manual" ? <Field label="請求額（円）" className="col-span-2"><Input inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} data-testid="statement-amount" /></Field> : (
            <div className="col-span-2 space-y-2">
              <Field label="CSV" hint="列: 利用日,利用先,金額 … と 合計行。合計と明細の和が一致しない場合は登録しません。"><Textarea className="h-40 font-mono text-sm" value={f.csv} onChange={(e) => { setF({ ...f, csv: e.target.value }); setPreview(null); }} /></Field>
              {preview && <div className={cx("text-sm", preview.valid ? "text-green" : "text-red")} role="status">{preview.valid ? `検証済み: ${preview.lines.length}行・合計 ${fmtYen(preview.total)}` : `検証エラー: ${preview.errors.join(" / ")}`}</div>}
            </div>
          )}
        </div>
      </Modal>
    </Section>
  );
}

function Chat() {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const send = async (text: string) => {
    const next = [...msgs, { role: "user" as const, content: text }]; setMsgs(next); setBusy(true);
    try { const r = await api.post<{ reply: string; provider: string }>("/cards/chat", { history: next.map((m) => ({ role: m.role, content: m.content })) }); setMsgs([...next, { role: "assistant", content: r.reply, provider: r.provider }]); }
    catch (e: any) { setMsgs([...next, { role: "assistant", content: `エラー: ${e.message}` }]); } finally { setBusy(false); }
  };
  return <ChatPanel messages={msgs} onSend={send} busy={busy} placeholder="使いすぎや代替案を相談…" emptyHint="今月の利用・予算・支払予定を参照して答えます。" />;
}
