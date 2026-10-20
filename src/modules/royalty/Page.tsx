import { useMemo, useState } from "react";
import { PageHeader, Card, Badge, Button, Input, Select, Field, Textarea, Modal, Segmented, Toggle, PageSkeleton, EmptyState, ErrorBanner, Stagger, Item, useToast, cx } from "@/components/ui";
import { api, useApi, fmtDateTime } from "@/lib/api";

type Status = "target" | "review" | "excluded";
type Mail = { id: string; provider: string; provider_label: string; subject: string; sender: string | null; received_at: string; target_month: string | null; status: Status; processed: boolean; link: string | null; portal: string | null };
type ListRes = { mails: Mail[]; providers: { key: string; label: string }[] };
type Summary = { byProvider: { provider: string; status: Status; n: number }[]; months: string[]; pending_target: number };

const STATUS_LABEL: Record<Status, string> = { target: "対象", review: "要確認", excluded: "対象外" };
const STATUS_TONE: Record<Status, "green" | "orange" | "neutral"> = { target: "green", review: "orange", excluded: "neutral" };
const PROVIDER_TONE: Record<string, "accent" | "purple" | "green" | "orange" | "neutral" | "red"> = { nextone: "accent", dcoret: "purple", mcjp: "green", rights_services: "orange", ponycanyon: "red", basemint: "accent", unknown: "neutral" };
const monthLabel = (m: string | null) => m ? `${m.slice(0, 4)}年${Number(m.slice(5, 7))}月` : "月不明";

export default function Page() {
  const toast = useToast();
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState<Status | "all">("all");
  const [month, setMonth] = useState("");
  const [unprocessedOnly, setUnprocessedOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const qs = useMemo(() => { const p = new URLSearchParams(); if (provider) p.set("provider", provider); if (status !== "all") p.set("status", status); if (month) p.set("month", month); if (unprocessedOnly) p.set("processed", "0"); const s = p.toString(); return s ? `?${s}` : ""; }, [provider, status, month, unprocessedOnly]);
  const list = useApi<ListRes>(`/royalty${qs}`);
  const summary = useApi<Summary>("/royalty/summary");
  const reload = () => { list.reload(true); summary.reload(true); };

  const patch = async (m: Mail, body: Partial<Pick<Mail, "status" | "processed">>) => {
    list.setData((d) => d ? { ...d, mails: d.mails.map((x) => x.id === m.id ? { ...x, ...body } : x) } : d);
    try { await api.patch(`/royalty/${m.id}`, body); summary.reload(true); } catch (e: any) { toast(e?.message ?? "更新に失敗しました", "error"); list.reload(true); }
  };
  const sync = async () => {
    setSyncing(true);
    try { const r = await api.post<{ connected: boolean; added?: number }>("/royalty/gmail/sync"); toast(r.connected ? `Gmailから${r.added ?? 0}件を追加しました` : "Gmailは未接続です（設定で連携してください）", r.connected ? "success" : "neutral"); if (r.connected) reload(); }
    catch (e: any) { toast(e?.message ?? "同期に失敗しました", "error"); } finally { setSyncing(false); }
  };

  if (list.loading && !list.data) return <PageSkeleton />;
  const counts = (s: Status) => summary.data?.byProvider.filter((r) => r.status === s).reduce((a, r) => a + r.n, 0) ?? 0;

  return (
    <div className="pb-10">
      <PageHeader title="明細" subtitle="著作権使用料・配信収益の明細通知を分類します。通知の到着であり、入金の確認ではありません。" actions={
        <>
          <Button onClick={sync} loading={syncing} data-testid="royalty-sync">Gmailを同期</Button>
          <Button variant="primary" onClick={() => setAdding(true)} data-testid="royalty-manual">手動で登録</Button>
        </>
      } />

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <Segmented value={status} onChange={setStatus} options={[{ value: "all", label: "すべて" }, { value: "target", label: `対象 ${counts("target")}` }, { value: "review", label: `要確認 ${counts("review")}` }, { value: "excluded", label: "対象外" }]} />
        <Select aria-label="配信元" value={provider} onChange={(e) => setProvider(e.target.value)} className="w-44" data-testid="royalty-filter-provider"><option value="">配信元すべて</option>{list.data?.providers.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</Select>
        <Select aria-label="対象月" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" data-testid="royalty-filter-month"><option value="">対象月すべて</option>{summary.data?.months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</Select>
        <label className="flex items-center gap-1.5 text-xs text-label-2" data-testid="royalty-filter-unprocessed"><span>未処理のみ</span><Toggle checked={unprocessedOnly} onChange={setUnprocessedOnly} label="未処理のみ" /></label>
        {summary.data && summary.data.pending_target > 0 && <span className="text-xs text-label-2 ml-auto">未処理の対象 {summary.data.pending_target}件</span>}
      </div>

      {(list.error || summary.error) && <ErrorBanner message={list.error ?? summary.error} onRetry={reload} testId="royalty-error" />}

      {list.data && list.data.mails.length === 0 ? (
        <Card><EmptyState title="該当する明細通知はありません" hint="Gmailの同期、または「手動で登録」で追加できます。" /></Card>
      ) : (
        <Stagger className="space-y-2" key={qs}>
          {list.data?.mails.map((m) => (
            <Item key={m.id}>
              <div data-testid={`mail-row-${m.id}`}><Card className={cx("flex flex-col md:flex-row md:items-center gap-3", m.processed && "opacity-60")}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span data-testid={`mail-provider-${m.id}`}><Badge tone={PROVIDER_TONE[m.provider] ?? "neutral"}>{m.provider_label}</Badge></span>
                    <span data-testid={`mail-status-badge-${m.id}`}><Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge></span>
                    <span className="text-xs text-label-2 tabular">{monthLabel(m.target_month)}</span>
                  </div>
                  <div className="font-medium mt-1 truncate" title={m.subject}>{m.subject}</div>
                  <div className="text-xs text-label-3 mt-0.5 truncate">{m.sender ?? "送信元不明"}　受信 {fmtDateTime(m.received_at)}</div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="inline-flex p-0.5 rounded-[var(--radius-md)] bg-fill" role="group" aria-label={`「${m.subject}」の状態`} data-testid={`mail-status-${m.id}`}>
                    {(["target", "review", "excluded"] as Status[]).map((s) => (
                      <button key={s} type="button" onClick={() => patch(m, { status: s })} aria-pressed={m.status === s} className={cx("focus-ring px-3 h-8 rounded-[calc(var(--radius-md)-2px)] text-sm font-medium transition-colors whitespace-nowrap", m.status === s ? "bg-elevated text-label shadow-[var(--shadow-card)]" : "text-label-2 hover:text-label")}>{STATUS_LABEL[s]}</button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-label-2" data-testid={`mail-processed-${m.id}`}><span>処理済</span><Toggle checked={m.processed} onChange={(v) => patch(m, { processed: v })} label="処理済" /></label>
                  {m.portal && <a href={m.portal} target="_blank" rel="noreferrer" className="focus-ring rounded-[var(--radius-sm)] text-accent text-sm hover:underline whitespace-nowrap">ポータルを開く</a>}
                </div>
              </Card></div>
            </Item>
          ))}
        </Stagger>
      )}

      <p className="text-xs text-label-3 mt-6 px-1">明細サイトへの自動ログインや金額の集計は行いません。公開通知の到着は入金の確認とは別です。</p>

      <ManualModal open={adding} onClose={() => setAdding(false)} onSaved={(m) => { setAdding(false); toast(`${m.provider_label}・${STATUS_LABEL[m.status]}として登録しました`, "success"); reload(); }} />
    </div>
  );
}

function ManualModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (m: Mail) => void }) {
  const toast = useToast();
  const [subject, setSubject] = useState(""); const [sender, setSender] = useState(""); const [body, setBody] = useState(""); const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!subject.trim()) { toast("件名を入力してください", "error"); return; }
    setBusy(true);
    try { const m = await api.post<Mail>("/royalty/manual", { subject: subject.trim(), sender: sender.trim() || undefined, body: body.trim() || undefined, link: link.trim() || null }); setSubject(""); setSender(""); setBody(""); setLink(""); onSaved(m); }
    catch (e: any) { toast(e?.message ?? "登録に失敗しました", "error"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="明細通知を手動で登録" footer={<><Button onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={save} loading={busy} data-testid="manual-save">登録</Button></>}>
      <div className="space-y-4">
        <Field label="件名"><Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="【NexTone】配信使用料分配明細公開のお知らせ" data-testid="manual-subject" /></Field>
        <Field label="送信元"><Input value={sender} onChange={(e) => setSender(e.target.value)} placeholder="info@nex-tone.co.jp" data-testid="manual-sender" /></Field>
        <Field label="本文（任意）" hint="対象年月（2026年3月 / 2026/03）を本文からも読み取ります。"><Textarea value={body} onChange={(e) => setBody(e.target.value)} data-testid="manual-body" /></Field>
        <Field label="ポータルのリンク（任意）"><Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" /></Field>
      </div>
    </Modal>
  );
}
