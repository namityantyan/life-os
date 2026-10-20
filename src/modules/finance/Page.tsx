import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { PageHeader, Card, Section, Stat, Badge, Button, Input, Select, Field, Textarea, Modal, PageSkeleton, EmptyState, Stagger, Item, useToast, cx } from "@/components/ui";
import { api, useApi, fmtYen, todayJst } from "@/lib/api";

type Reconcile = { status: "match" | "mismatch" | "unverified"; computed: number; pdf_total: number | null; diff: number | null };
type Invoice = { id: string; client: string; issued_on: string; amount: number; tax: number; withholding: number; pdf_total: number | null; status: "issued" | "paid"; notes: string | null; reconcile: Reconcile };
type MonthRow = { month: string; count: number; amount: number; tax: number; withholding: number; total: number; mismatches: number };
type Summary = { year: number; months: MonthRow[]; totals: { count: number; amount: number; tax: number; withholding: number; total: number }; mismatches: Invoice[]; years: number[] };
type Rules = { include: string[]; exclude: string[]; senders: string[] };

const RATE_LOW = 0.1021, RATE_HIGH = 0.2042, THRESHOLD = 1_000_000;
const calcWithholding = (fee: number) => fee > 0 ? Math.floor(Math.min(fee, THRESHOLD) * RATE_LOW + Math.max(fee - THRESHOLD, 0) * RATE_HIGH + 1e-9) : 0;
const calcTax = (fee: number) => fee > 0 ? Math.floor(fee * 0.1 + 1e-9) : 0;
const monthLabel = (m: string) => `${Number(m.slice(5, 7))}月`;

export default function Page() {
  const toast = useToast();
  const [year, setYear] = useState(Number(todayJst().slice(0, 4)));
  const summary = useApi<Summary>(`/finance/summary?year=${year}`);
  const list = useApi<{ invoices: Invoice[] }>(`/finance?year=${year}`);
  const [editing, setEditing] = useState<Invoice | "new" | null>(null);
  const [scanning, setScanning] = useState(false);

  const years = useMemo(() => { const s = new Set<number>([Number(todayJst().slice(0, 4)), year, ...(summary.data?.years ?? [])]); return [...s].sort((a, b) => b - a); }, [summary.data, year]);
  const reload = () => { summary.reload(true); list.reload(true); };

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.post<{ connected: boolean; hits?: unknown[] }>("/finance/gmail/scan");
      toast(r.connected ? `Gmailを確認しました（検知 ${r.hits?.length ?? 0}件）` : "Gmailは未接続です（設定で連携してください）", r.connected ? "success" : "neutral");
    } catch (e: any) { toast(e?.message ?? "失敗しました", "error"); } finally { setScanning(false); }
  };

  if (summary.loading && !summary.data) return <PageSkeleton />;
  const s = summary.data;
  const error = summary.error ?? list.error;

  return (
    <div className="pb-10">
      <PageHeader title="お金" subtitle="発行した請求書と源泉徴収の記録。申告・納税の実行は行いません。" actions={
        <>
          <Select aria-label="年" value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28" data-testid="finance-year">{years.map((y) => <option key={y} value={y}>{y}年</option>)}</Select>
          <Button variant="primary" onClick={() => setEditing("new")} data-testid="finance-add">請求書を追加</Button>
        </>
      } />

      {error && (
        <div className="mb-5 rounded-[var(--radius-lg)] bg-red/10 text-red px-5 py-3 text-sm flex flex-wrap items-center gap-3" role="alert" data-testid="finance-error">
          <span>読み込みに失敗しました（{error}）</span>
          <Button size="sm" onClick={() => { summary.reload(); list.reload(); }}>再読み込み</Button>
        </div>
      )}

      {s && (
        <Card className="mb-6">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <Stat label="請求書" value={`${s.totals.count}件`} />
            <Stat label="報酬" value={fmtYen(s.totals.amount)} />
            <Stat label="消費税" value={fmtYen(s.totals.tax)} />
            <Stat label="源泉徴収" value={<span data-testid="finance-total-withholding">{fmtYen(s.totals.withholding)}</span>} tone="accent" />
            <Stat label="請求額合計" value={fmtYen(s.totals.total)} hint="報酬＋消費税−源泉徴収" />
          </div>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        <Section title={`${year}年 月別`}>
          <Card padded={false} className="overflow-x-auto">
            <table className="w-full text-sm tabular" data-testid="finance-monthly">
              <thead><tr className="text-label-2 text-xs"><th className="text-left font-medium px-5 py-3">月</th><th className="text-right font-medium px-3 py-3">件数</th><th className="text-right font-medium px-3 py-3">報酬</th><th className="text-right font-medium px-3 py-3">消費税</th><th className="text-right font-medium px-3 py-3">源泉徴収</th><th className="text-right font-medium px-5 py-3">請求額</th></tr></thead>
              <tbody>
                {s?.months.map((m) => (
                  <tr key={m.month} data-testid={`month-row-${m.month}`} className={cx("border-t border-separator", m.count === 0 && "text-label-3")}>
                    <td className="px-5 py-2.5 text-left">{monthLabel(m.month)}{m.mismatches > 0 && <Badge tone="orange" className="ml-2">不一致 {m.mismatches}</Badge>}</td>
                    <td className="px-3 py-2.5 text-right">{m.count || "—"}</td>
                    <td className="px-3 py-2.5 text-right">{m.count ? fmtYen(m.amount) : "—"}</td>
                    <td className="px-3 py-2.5 text-right">{m.count ? fmtYen(m.tax) : "—"}</td>
                    <td className="px-3 py-2.5 text-right" data-testid={`month-withholding-${m.month}`}>{m.count ? fmtYen(m.withholding) : "—"}</td>
                    <td className="px-5 py-2.5 text-right">{m.count ? fmtYen(m.total) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </Section>

        <Section title="請求書" action={<span className="text-xs text-label-3">{list.data?.invoices.length ?? 0}件</span>}>
          {list.data && list.data.invoices.length === 0 ? (
            <Card><EmptyState title="この年の請求書はまだありません" hint="「請求書を追加」から記録すると、消費税と源泉徴収を自動計算します。" /></Card>
          ) : (
            <Stagger className="space-y-2" key={year}>
              {list.data?.invoices.map((inv) => (
                <Item key={inv.id}>
                  <div data-testid={`invoice-row-${inv.id}`}><Card onClick={() => setEditing(inv)} className="flex items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium truncate">{inv.client}</span>
                        {inv.status === "paid" && <Badge tone="green">入金済</Badge>}
                        {inv.reconcile.status === "mismatch" && <Badge tone="orange" className="invoice-mismatch">PDFと不一致 {inv.reconcile.diff != null && (inv.reconcile.diff > 0 ? `+${inv.reconcile.diff}` : inv.reconcile.diff)}円</Badge>}
                        {inv.reconcile.status === "match" && <Badge tone="green">PDF一致</Badge>}
                      </div>
                      <div className="text-xs text-label-2 mt-0.5">{inv.issued_on}　源泉 <span className="tabular">{fmtYen(inv.withholding)}</span></div>
                    </div>
                    <div className="text-right shrink-0"><div className="font-semibold tabular">{fmtYen(inv.reconcile.computed)}</div><div className="text-xs text-label-3 tabular">報酬 {fmtYen(inv.amount)}</div></div>
                  </Card></div>
                </Item>
              ))}
            </Stagger>
          )}
        </Section>
      </div>

      <div className="mt-8">
        <MailRulesEditor onScan={scan} scanning={scanning} />
      </div>

      <InvoiceModal key={editing === "new" ? "new" : editing?.id ?? "closed"} invoice={editing === "new" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
    </div>
  );
}

function InvoiceModal({ invoice, open, onClose, onSaved }: { invoice: Invoice | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [client, setClient] = useState(invoice?.client ?? "");
  const [issuedOn, setIssuedOn] = useState(invoice?.issued_on ?? todayJst());
  const [amount, setAmount] = useState(invoice ? String(invoice.amount) : "");
  const [tax, setTax] = useState(invoice ? String(invoice.tax) : "");
  const [withholding, setWithholding] = useState(invoice ? String(invoice.withholding) : "");
  const [taxTouched, setTaxTouched] = useState(Boolean(invoice));
  const [whTouched, setWhTouched] = useState(Boolean(invoice));
  const [pdfTotal, setPdfTotal] = useState(invoice?.pdf_total != null ? String(invoice.pdf_total) : "");
  const [status, setStatus] = useState<"issued" | "paid">(invoice?.status ?? "issued");
  const [notes, setNotes] = useState(invoice?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const fee = Number(amount) || 0;
  useEffect(() => { if (!taxTouched) setTax(fee ? String(calcTax(fee)) : ""); if (!whTouched) setWithholding(fee ? String(calcWithholding(fee)) : ""); }, [fee, taxTouched, whTouched]);
  const computed = Math.round(fee + (Number(tax) || 0) - (Number(withholding) || 0));
  const pdf = pdfTotal.trim() === "" ? null : Number(pdfTotal);
  const mismatch = pdf != null && Number.isFinite(pdf) && Math.abs(pdf - computed) > 1;

  const save = async () => {
    if (!client.trim() || !fee) { toast("請求先と報酬を入力してください", "error"); return; }
    setBusy(true);
    try {
      const body = { client: client.trim(), issued_on: issuedOn, amount: fee, tax: Number(tax) || 0, withholding: Number(withholding) || 0, pdf_total: pdf, status, notes: notes.trim() || null };
      if (invoice) await api.put(`/finance/${invoice.id}`, body); else await api.post("/finance", body);
      toast("保存しました", "success"); onSaved();
    } catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!invoice || !confirm("この請求書を削除しますか？")) return;
    setBusy(true);
    try { await api.del(`/finance/${invoice.id}`); toast("削除しました"); onSaved(); }
    catch (e: any) { toast(e?.message ?? "削除に失敗しました", "error"); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={invoice ? "請求書を編集" : "請求書を追加"} footer={
      <>
        {invoice && <Button variant="danger" onClick={remove} disabled={busy} className="mr-auto">削除</Button>}
        <Button onClick={onClose}>キャンセル</Button>
        <Button variant="primary" onClick={save} loading={busy} data-testid="invoice-save">保存</Button>
      </>
    }>
      <div className="space-y-4">
        <Field label="請求先"><Input value={client} onChange={(e) => setClient(e.target.value)} placeholder="株式会社〇〇" data-testid="invoice-client" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="請求日"><Input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} data-testid="invoice-date" /></Field>
          <Field label="状態"><Select value={status} onChange={(e) => setStatus(e.target.value as "issued" | "paid")}><option value="issued">発行済</option><option value="paid">入金済</option></Select></Field>
        </div>
        <Field label="報酬（税抜）"><Input type="number" inputMode="numeric" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100000" data-testid="invoice-amount" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="消費税（10%）" hint={taxTouched ? "手入力" : "自動計算"}><Input type="number" inputMode="numeric" min={0} value={tax} onChange={(e) => { setTaxTouched(true); setTax(e.target.value); }} data-testid="invoice-tax" /></Field>
          <Field label="源泉徴収" hint={whTouched ? "手入力" : "100万円まで10.21%、超過分20.42%"}><Input type="number" inputMode="numeric" min={0} value={withholding} onChange={(e) => { setWhTouched(true); setWithholding(e.target.value); }} data-testid="invoice-withholding" /></Field>
        </div>
        <div className="flex items-center justify-between rounded-[var(--radius-md)] bg-subtle px-4 py-3">
          <span className="text-sm text-label-2">計算上の請求額</span><span className="font-semibold tabular" data-testid="invoice-computed">{fmtYen(computed)}</span>
        </div>
        <Field label="PDF記載額（請求額）" hint="保存したPDFに記載の振込額。±1円まで一致とみなします。">
          <div className="flex items-center gap-2">
            <Input type="number" inputMode="numeric" value={pdfTotal} onChange={(e) => setPdfTotal(e.target.value)} placeholder="未入力なら照合しません" data-testid="invoice-pdf-total" />
            {pdf != null && Number.isFinite(pdf) && (mismatch ? <span data-testid="invoice-mismatch-badge"><Badge tone="orange" className="shrink-0">不一致 {pdf - computed > 0 ? "+" : ""}{pdf - computed}円</Badge></span> : <Badge tone="green" className="shrink-0">一致</Badge>)}
          </div>
        </Field>
        <Field label="メモ"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-16" /></Field>
      </div>
    </Modal>
  );
}

function MailRulesEditor({ onScan, scanning }: { onScan: () => void; scanning: boolean }) {
  const toast = useToast();
  const rules = useApi<{ rules: Rules; defaults: Rules }>("/finance/mail-rules");
  const [include, setInclude] = useState(""); const [exclude, setExclude] = useState(""); const [senders, setSenders] = useState("");
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false);
  const [testSubject, setTestSubject] = useState(""); const [testResult, setTestResult] = useState<{ match: boolean; reason: string } | null>(null);
  useEffect(() => { if (rules.data && !dirty) { setInclude(rules.data.rules.include.join("\n")); setExclude(rules.data.rules.exclude.join("\n")); setSenders(rules.data.rules.senders.join("\n")); } }, [rules.data, dirty]);
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    setBusy(true);
    try { await api.put("/finance/mail-rules", { include: lines(include), exclude: lines(exclude), senders: lines(senders) }); setDirty(false); rules.reload(true); toast("検知条件を保存しました", "success"); }
    catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); } finally { setBusy(false); }
  };
  const runTest = async () => { if (!testSubject.trim()) return; setTestResult(await api.post("/finance/mail-rules/test", { subject: testSubject })); };
  return (
    <Section title="請求書・領収書メールの検知条件" action={<Button size="sm" onClick={onScan} loading={scanning} data-testid="finance-gmail-scan">Gmailを確認</Button>}>
      <Card>
        <p className="text-sm text-label-2 mb-4">件名に含まれる語で請求書・領収書メールを検知します。除外語が優先されます。送信元を指定すると、その送信元のみ対象になります（1行1条件）。</p>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="対象の語"><Textarea value={include} onChange={(e) => { setDirty(true); setInclude(e.target.value); }} data-testid="rules-include" /></Field>
          <Field label="除外の語"><Textarea value={exclude} onChange={(e) => { setDirty(true); setExclude(e.target.value); }} data-testid="rules-exclude" /></Field>
          <Field label="送信元（任意）"><Textarea value={senders} onChange={(e) => { setDirty(true); setSenders(e.target.value); }} placeholder="client.co.jp" data-testid="rules-senders" /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <Input value={testSubject} onChange={(e) => setTestSubject(e.target.value)} placeholder="件名を入れて試す" className="md:max-w-sm" data-testid="rules-test-subject" />
          <Button onClick={runTest} data-testid="rules-test">試す</Button>
          {testResult && <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} data-testid="rules-test-result"><Badge tone={testResult.match ? "green" : "neutral"}>{testResult.match ? "検知" : "対象外"}</Badge> <span className="text-xs text-label-2">{testResult.reason}</span></motion.span>}
          <Button variant="primary" onClick={save} loading={busy} disabled={!dirty} className="ml-auto" data-testid="rules-save">条件を保存</Button>
        </div>
      </Card>
    </Section>
  );
}
