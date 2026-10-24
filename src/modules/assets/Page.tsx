import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { PageHeader, PageSkeleton, Card, Section, Stat, Badge, Button, Input, Select, Field, Textarea, Toggle, Segmented, Modal, EmptyState, ErrorBanner, Stagger, Item, ChatPanel, ChartTip, useChartColors, useToast, type ChatMsg } from "@/components/ui";
import { api, useApi, fmtYen, fmtNum, fmtDateTime, todayJst } from "@/lib/api";
import type { AssetAccount, AssetOverview, BalancesResponse, AssetPlan, Allocation, AssetCategory, LatestBalance } from "@shared/assets";
import { ASSET_CATEGORIES, ASSET_CATEGORY_LABELS } from "@shared/assets";

type Tab = "overview" | "entry" | "accounts" | "allocate" | "chat";
const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "概要" }, { value: "entry", label: "残高を入力" }, { value: "accounts", label: "口座の管理" }, { value: "allocate", label: "使う・運用する" }, { value: "chat", label: "FP相談" },
];
const fmtMan = (v: number) => (Math.abs(v) >= 10000 ? `${(v / 10000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}万` : v.toLocaleString("ja-JP"));
const fmtD = (d: string | null | undefined) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "—");

export default function Page() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const setTab = (t: Tab) => setParams((p) => { p.set("tab", t); return p; }, { replace: true });
  const toast = useToast();
  const accounts = useApi<{ accounts: AssetAccount[] }>("/assets/accounts");
  const overview = useApi<AssetOverview>("/assets/overview");
  const reloadAll = () => { accounts.reload(true); overview.reload(true); };
  useEffect(() => { const f = params.get("freee"); if (f) { toast(f === "connected" ? "freeeと接続しました" : "freeeの接続に失敗しました", f === "connected" ? "success" : "error"); setParams((p) => { p.delete("freee"); return p; }, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (accounts.loading && !accounts.data) return <PageSkeleton />;
  if (!accounts.data) return <div><PageHeader title="資産" /><ErrorBanner message={accounts.error ?? overview.error} onRetry={reloadAll} testId="assets-error" /><EmptyState title="資産を取得できません" /></div>;
  const accs = accounts.data.accounts;
  return (
    <div>
      <PageHeader title="資産" subtitle="残高と円換算評価額。総資産は負債を控除した純資産ではありません。" actions={<Segmented value={tab} onChange={setTab} options={TABS} />} />
      {tab === "overview" && <OverviewTab overview={overview.data} overviewError={overview.error} onChanged={reloadAll} />}
      {tab === "entry" && <EntryTab accounts={accs} onSaved={reloadAll} />}
      {tab === "accounts" && <AccountsTab accounts={accs} onChanged={reloadAll} />}
      {tab === "allocate" && <AllocateTab />}
      {tab === "chat" && <ChatTab />}
    </div>
  );
}

/* ---------------- 概要 ---------------- */
function OverviewTab({ overview, overviewError, onChanged }: { overview: AssetOverview | null; overviewError: string | null; onChanged: () => void }) {
  const toast = useToast();
  const [importing, setImporting] = useState(false);
  const [owner, setOwner] = useState<"all" | "personal" | "corporate">("all");
  const [category, setCategory] = useState<"all" | AssetCategory>("all");
  const [period, setPeriod] = useState<"3m" | "1y" | "all">("1y");
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const cc = useChartColors();
  const to = todayJst();
  const from = period === "all" ? "2000-01-01" : new Date(Date.parse(to) - (period === "3m" ? 92 : 365) * 86400e3).toISOString().slice(0, 10);
  const bal = useApi<BalancesResponse>(`/assets/balances?from=${from}&to=${to}&owner=${owner}&category=${category}`);
  const doImport = async () => {
    setImporting(true);
    try { const r = await api.post<{ imported: number; errors: string[] }>("/assets/import", { csv }); toast(`${r.imported}件を取り込みました${r.errors.length ? `（エラー ${r.errors.length}件）` : ""}`, r.errors.length ? "error" : "success"); setImportOpen(false); setCsv(""); bal.reload(true); onChanged(); }
    catch (e: any) { toast(e.message, "error"); } finally { setImporting(false); }
  };
  if (!overview) return overviewError ? <div><ErrorBanner message={overviewError} onRetry={onChanged} testId="assets-error" /><EmptyState title="概要を取得できません" /></div> : <PageSkeleton cards={3} />;
  const rr = bal.data?.recorded_range;
  return (
    <div className="space-y-6">
      {bal.error && <ErrorBanner message={bal.error} onRetry={() => bal.reload()} className="mb-0" />}
      <Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
          <Stat label="総資産（負債を除く）" value={overview.total == null ? "—" : fmtYen(overview.total)} hint={overview.as_of ? `最終記録 ${fmtD(overview.as_of)}${overview.stale_count ? `・古い口座 ${overview.stale_count}件` : ""}` : "記録がありません"} />
          <Stat label="負債" value={overview.liabilities == null ? "—" : fmtYen(overview.liabilities)} hint="総資産から自動控除しません" />
          {overview.by_owner_type.map((o) => <Stat key={o.owner_type} label={o.owner_type === "personal" ? "個人" : "法人"} value={fmtYen(o.total)} hint={o.stale ? "参考額を含む" : undefined} tone={o.stale ? "orange" : undefined} />)}
          {overview.unknown_count > 0 && <Stat label="残高不明の口座" value={`${overview.unknown_count}件`} hint="空欄は不明として扱います" />}
        </div>
      </Card>
      <Section title="資産の推移" action={<div className="flex flex-wrap gap-2 items-center">
        <div className="w-36"><Select value={owner} onChange={(e) => setOwner(e.target.value as any)} aria-label="名義" className="h-8 text-sm"><option value="all">すべての名義</option><option value="personal">個人</option><option value="corporate">法人</option></Select></div>
        <div className="w-36"><Select value={category} onChange={(e) => setCategory(e.target.value as any)} aria-label="資産区分" className="h-8 text-sm"><option value="all">すべての区分</option>{ASSET_CATEGORIES.map((k) => <option key={k} value={k}>{ASSET_CATEGORY_LABELS[k]}</option>)}</Select></div>
        <Segmented value={period} onChange={setPeriod} options={[{ value: "3m", label: "3か月" }, { value: "1y", label: "1年" }, { value: "all", label: "全期間" }]} />
      </div>}>
        <Card>
          {bal.data && bal.data.series.length ? (
            <>
              <div className="text-xs text-label-2 mb-2 tabular">記録のある範囲 {rr ? `${rr.from} 〜 ${rr.to}` : "—"}（指定期間 {from} 〜 {to}）。記録のない日は作成しません。</div>
              <div className="h-64" data-testid="asset-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={bal.data.series} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
                    <defs><linearGradient id="assetFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={cc.accent} stopOpacity={0.25} /><stop offset="100%" stopColor={cc.accent} stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid vertical={false} stroke={cc.separator} />
                    <XAxis dataKey="date" tickFormatter={fmtD} tick={{ fill: cc.label2, fontSize: cc.tickFont }} axisLine={false} tickLine={false} minTickGap={32} />
                    <YAxis tickFormatter={fmtMan} tick={{ fill: cc.label2, fontSize: cc.tickFont }} axisLine={false} tickLine={false} width={44} />
                    <Tooltip cursor={{ stroke: cc.label3 }} content={({ active, payload }) => active && payload?.[0] ? <ChartTip label={`${fmtD((payload[0].payload as any).date)}${(payload[0].payload as any).carried ? "・一部持ち越し" : ""}`} value={fmtYen(payload[0].value as number)} /> : null} />
                    <Area type="monotone" dataKey="total" stroke={cc.accent} strokeWidth={2} fill="url(#assetFill)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: cc.elevated }} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          ) : <EmptyState title="この条件の記録はまだありません" hint="「残高を入力」で記録すると推移が表示されます" />}
        </Card>
      </Section>
      <Section title="口座ごとの最新残高" action={<div className="flex gap-2"><Button size="sm" onClick={() => { window.location.href = "/api/assets/export.csv"; }}>CSV書き出し</Button><Button size="sm" onClick={() => setImportOpen(true)} data-testid="import-open">CSV取り込み</Button></div>}>
        {overview.accounts.length === 0 ? <EmptyState title="口座がありません" hint="「口座の管理」から追加してください" /> : (
          <Stagger className="card divide-y divide-separator">
            {overview.accounts.map((a) => (
              <Item key={a.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1"><div className="font-medium truncate">{a.name}</div><div className="text-xs text-label-2">{a.owner_type === "personal" ? "個人" : a.owner}・{ASSET_CATEGORY_LABELS[a.category]}{a.source === "freee" ? "・freee" : ""}</div></div>
                <LatestCell a={a} l={a.latest} />
              </Item>
            ))}
          </Stagger>
        )}
      </Section>
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="CSV取り込み" footer={<><Button onClick={() => setImportOpen(false)}>キャンセル</Button><Button variant="primary" onClick={doImport} disabled={!csv.trim()} loading={importing}>取り込む</Button></>}>
        <p className="text-sm text-label-2 mb-2">列: date,account,quantity,rate,jpy_value。口座名は登録済みの名前と一致させてください。空欄は不明として記録しません。</p>
        <Field label="CSV"><Textarea className="h-40 font-mono text-sm" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"date,account,quantity,rate,jpy_value\n2026-10-01,メイン銀行,1500000,,"} /></Field>
      </Modal>
    </div>
  );
}
function LatestCell({ a, l }: { a: AssetAccount; l: LatestBalance | null }) {
  if (!l || l.jpy_value == null && l.quantity == null) return <div className="text-right"><div className="text-label-3">未取得</div></div>;
  return (
    <div className="text-right">
      <div className="tabular font-medium flex items-center justify-end gap-2">{l.stale && <Badge tone="orange">参考</Badge>}{l.jpy_value == null ? `${fmtNum(l.quantity, 4)} ${a.unit ?? a.currency}（円換算なし）` : fmtYen(l.jpy_value)}</div>
      <div className="text-xs text-label-2 tabular">{a.currency !== "JPY" && l.quantity != null ? `${fmtNum(l.quantity, 4)} ${a.unit ?? a.currency}・` : ""}{fmtD(l.recorded_on)} 記録{l.source === "freee" ? "・freee同期" : ""}</div>
    </div>
  );
}

/* ---------------- 残高を入力 ---------------- */
type Draft = { quantity: string; rate: string };
function EntryTab({ accounts, onSaved }: { accounts: AssetAccount[]; onSaved: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(todayJst());
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [manualOnly, setManualOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const day = useApi<BalancesResponse>(`/assets/balances?from=${date}&to=${date}&owner=all&category=all`);
  const rowsForDay = useMemo(() => { const m: Record<string, BalancesResponse["rows"][number]> = {}; for (const r of day.data?.rows ?? []) if (!m[r.account_id] || r.source !== "freee") m[r.account_id] = r; return m; }, [day.data]);
  // Initialise the draft from the day's stored rows, but never overwrite a value the user already typed (only fill empty fields).
  useEffect(() => { setDraft((prev) => { const d: Record<string, Draft> = { ...prev }; for (const a of accounts) { const r = rowsForDay[a.id]; const stored = { quantity: r && r.source !== "freee" && r.quantity != null ? String(r.quantity) : "", rate: r && r.source !== "freee" && r.rate != null ? String(r.rate) : "" }; const cur = prev[a.id]; d[a.id] = { quantity: cur?.quantity ? cur.quantity : stored.quantity, rate: cur?.rate ? cur.rate : stored.rate }; } return d; }); }, [rowsForDay, accounts]);
  useEffect(() => { setDraft({}); }, [date]);
  const freeeRow = (a: AssetAccount) => { const r = rowsForDay[a.id]; return a.source === "freee" && r?.source === "freee" ? r : null; };
  const rows = accounts.filter((a) => !manualOnly || !freeeRow(a));
  const copyPrevious = async () => {
    const prev = new Date(Date.parse(date) - 86400e3).toISOString().slice(0, 10);
    const r = await api.get<BalancesResponse>(`/assets/balances?from=2000-01-01&to=${prev}&owner=all&category=all`);
    let n = 0;
    setDraft((d) => { const nd = { ...d }; for (const a of accounts) { if (nd[a.id]?.quantity !== "") continue; const l = r.latest[a.id]; if (l && l.quantity != null) { nd[a.id] = { quantity: String(l.quantity), rate: l.rate != null ? String(l.rate) : nd[a.id]?.rate ?? "" }; n++; } } return nd; });
    toast(n ? `${n}件の空欄に前回値を入れました（保存はまだです）` : "コピーできる前回値がありません");
  };
  const save = async () => {
    setSaving(true);
    try {
      const entries = accounts.map((a) => ({ account_id: a.id, quantity: draft[a.id]?.quantity === "" || draft[a.id]?.quantity == null ? null : Number(draft[a.id].quantity), rate: draft[a.id]?.rate ? Number(draft[a.id].rate) : null }));
      const r = await api.post<{ saved: number }>("/assets/balances", { date, entries });
      toast(`${r.saved}件を保存しました`, "success"); day.reload(true); onSaved();
    } catch (e: any) { toast(e.message, "error"); } finally { setSaving(false); }
  };
  const total = accounts.reduce((s, a) => { const q = draft[a.id]?.quantity; if (q === "" || q == null || a.category === "liability") return s; const n = Number(q); if (a.currency === "JPY") return s + n; const rt = Number(draft[a.id]?.rate); return s + (rt ? n * rt : 0); }, 0);
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="記録日"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="entry-date" className="w-44" /></Field>
          <Button onClick={copyPrevious} data-testid="copy-previous">前回値をコピー（空欄のみ）</Button>
          <label className="flex items-center gap-2 text-sm text-label-2 h-10"><Toggle checked={manualOnly} onChange={setManualOnly} label="手入力だけ表示" />手入力だけ表示</label>
          <div className="flex-1" />
          <Button variant="primary" onClick={save} loading={saving} data-testid="entry-save">保存</Button>
        </div>
        <p className="text-xs text-label-3 mt-3">空欄＝不明（記録しません）、0＝残高ゼロ。外貨などは数量とレートを入れると円換算します。</p>
      </Card>
      {accounts.length === 0 ? <EmptyState title="口座がありません" hint="「口座の管理」から追加してください" /> : (
        <Card padded={false}>
          <div className="divide-y divide-separator">
            {rows.map((a) => { const f = freeeRow(a); const stale = f ? Math.round((Date.parse(todayJst()) - Date.parse(f.recorded_on)) / 86400e3) > 2 : false; return (
              <div key={a.id} className="grid grid-cols-[1fr_auto] md:grid-cols-[1fr_12rem_8rem_10rem] items-center gap-3 px-5 py-3">
                <div className="min-w-0"><div className="font-medium truncate">{a.name}</div><div className="text-xs text-label-2">{a.owner_type === "personal" ? "個人" : a.owner}・{ASSET_CATEGORY_LABELS[a.category]}・{a.unit ?? a.currency}</div></div>
                {f ? (
                  <><div className="tabular text-right flex items-center justify-end gap-2 col-span-1 md:col-span-2">{stale && <Badge tone="orange">参考</Badge>}<Badge tone="accent">freee</Badge>{fmtYen(f.jpy_value)}</div><div className="text-xs text-label-2 text-right hidden md:block">{stale ? "同期が古いため参考額" : "銀行同期済み"}</div></>
                ) : (
                  <>
                    <Input inputMode="decimal" placeholder="空欄＝不明" aria-label={`${a.name} の残高`} data-testid={`qty-${a.name}`} value={draft[a.id]?.quantity ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [a.id]: { ...d[a.id], quantity: e.target.value } }))} className="text-right tabular" />
                    {a.currency !== "JPY" ? <Input inputMode="decimal" placeholder="レート" aria-label={`${a.name} のレート`} value={draft[a.id]?.rate ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [a.id]: { ...d[a.id], rate: e.target.value } }))} className="text-right tabular" /> : <div className="hidden md:block" />}
                    <div className="text-xs text-label-2 text-right hidden md:block tabular">{a.currency !== "JPY" && draft[a.id]?.quantity && draft[a.id]?.rate ? `≈ ${fmtYen(Number(draft[a.id].quantity) * Number(draft[a.id].rate))}` : rowsForDay[a.id] ? "この日の記録あり" : ""}</div>
                  </>
                )}
              </div>); })}
          </div>
          <div className="px-5 py-3 text-sm text-label-2 flex justify-between"><span>入力中の合計（負債を除く・円換算できる分）</span><span className="tabular font-medium text-label">{fmtYen(total)}</span></div>
        </Card>
      )}
    </div>
  );
}

/* ---------------- 口座の管理 ---------------- */
type FreeeStatus = { configured: boolean; connected: boolean; companies: { id: number; name: string }[]; connected_at: string | null; last_sync: { at: string; errors: string[]; checked: number; updated: number; stale: number } | null };
const emptyForm = { name: "", owner: "personal", owner_type: "personal" as "personal" | "corporate", category: "bank" as AssetCategory, currency: "JPY", unit: "", source: "manual" as "manual" | "freee", freee_company_id: "", freee_walletable_id: "" };
function AccountsTab({ accounts, onChanged }: { accounts: AssetAccount[]; onChanged: () => void }) {
  const toast = useToast();
  const freee = useApi<FreeeStatus>("/assets/freee/status");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AssetAccount | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [wallets, setWallets] = useState<{ id: number; name: string; last_balance?: number | null; last_synced_at?: string | null }[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const openNew = () => { setEditing(null); setForm(emptyForm); setOpen(true); };
  const openEdit = (a: AssetAccount) => { setEditing(a); setForm({ name: a.name, owner: a.owner, owner_type: a.owner_type, category: a.category, currency: a.currency, unit: a.unit ?? "", source: a.source, freee_company_id: a.freee_company_id ?? "", freee_walletable_id: a.freee_walletable_id ?? "" }); setOpen(true); };
  useEffect(() => { if (form.source === "freee" && form.freee_company_id) api.get<{ walletables: typeof wallets }>(`/assets/freee/companies/${form.freee_company_id}/walletables`).then((r) => setWallets(r.walletables)).catch(() => setWallets([])); else setWallets([]); }, [form.source, form.freee_company_id]);
  const submit = async () => {
    setSubmitting(true);
    try {
      const body = { ...form, unit: form.unit || null, freee_company_id: form.source === "freee" ? form.freee_company_id || null : null, freee_walletable_id: form.source === "freee" ? form.freee_walletable_id || null : null, owner: form.owner_type === "personal" ? "personal" : form.owner || "法人" };
      if (editing) await api.put(`/assets/accounts/${editing.id}`, body); else await api.post("/assets/accounts", body);
      setOpen(false); onChanged(); toast("保存しました", "success");
    } catch (e: any) { toast(e.message, "error"); } finally { setSubmitting(false); }
  };
  const archive = async (a: AssetAccount) => { if (!confirm(`「${a.name}」をアーカイブしますか？履歴は残ります。`)) return; await api.del(`/assets/accounts/${a.id}`); onChanged(); };
  const connect = async () => { try { const r = await api.get<{ url: string }>("/assets/freee/start"); window.location.href = r.url; } catch (e: any) { toast(e.message, "error"); } };
  const sync = async () => { setSyncing(true); try { const r = await api.post<{ connected: boolean; updated: number; checked: number; errors: string[] }>("/assets/freee/sync"); toast(r.connected ? `freeeを再確認しました（${r.checked}口座・更新${r.updated}件${r.errors.length ? `・エラー${r.errors.length}件` : ""}）` : "freeeは未接続です", r.errors.length ? "error" : "success"); freee.reload(true); onChanged(); } catch (e: any) { toast(e.message, "error"); } finally { setSyncing(false); } };
  const disconnect = async () => { if (!confirm("freeeの接続を解除しますか？保存したトークンを削除します。")) return; await api.post("/assets/freee/disconnect"); freee.reload(true); };
  const fs = freee.data;
  return (
    <div className="space-y-6">
      <Section title="freee連携" >
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-medium">{fs?.connected ? "接続済み" : "未接続"}{fs?.connected && fs.companies.length > 0 && <span className="text-label-2 font-normal">・{fs.companies.map((c) => c.name).join("、")}</span>}</div>
              <div className="text-xs text-label-2 mt-0.5">{!fs?.configured ? "FREEE_CLIENT_ID / FREEE_CLIENT_SECRET が未設定のため接続できません。" : fs.last_sync ? `最終確認 ${fmtDateTime(fs.last_sync.at)}・${fs.last_sync.checked}口座・古い ${fs.last_sync.stale}件${fs.last_sync.errors.length ? `・エラー: ${fs.last_sync.errors.join(" / ")}` : ""}` : "約1時間ごとにfreeeへ保存された銀行同期残高を読みます。銀行からfreeeへの同期は強制しません。"}</div>
            </div>
            {fs?.connected ? <><Button onClick={sync} loading={syncing} data-testid="freee-sync">銀行残高を更新</Button><Button variant="danger" onClick={disconnect}>接続を解除</Button></> : <Button variant="primary" onClick={connect} disabled={!fs?.configured} data-testid="freee-connect">freeeと接続</Button>}
          </div>
        </Card>
      </Section>
      <Section title="口座" action={<Button variant="primary" size="sm" onClick={openNew} data-testid="account-add">口座を追加</Button>}>
        {accounts.length === 0 ? <EmptyState title="口座がありません" action={<Button variant="primary" onClick={openNew}>最初の口座を追加</Button>} /> : (
          <Stagger className="card divide-y divide-separator">
            {accounts.map((a) => (
              <Item key={a.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1"><div className="font-medium truncate" data-testid="account-name">{a.name}</div><div className="text-xs text-label-2">{a.owner_type === "personal" ? "個人" : a.owner}・{ASSET_CATEGORY_LABELS[a.category]}・{a.unit ?? a.currency}{a.source === "freee" ? `・freee${a.freee_walletable_id ? "" : "（反映先未設定）"}` : ""}</div></div>
                <Button size="sm" onClick={() => openEdit(a)} aria-label={`${a.name}を編集`}>編集</Button><Button size="sm" variant="danger" onClick={() => archive(a)} aria-label={`${a.name}をアーカイブ`}>アーカイブ</Button>
              </Item>
            ))}
          </Stagger>
        )}
      </Section>
      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "口座を編集" : "口座を追加"} footer={<><Button onClick={() => setOpen(false)}>キャンセル</Button><Button variant="primary" onClick={submit} disabled={!form.name.trim()} loading={submitting} data-testid="account-submit">保存</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="口座名" className="col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="account-name-input" /></Field>
          <Field label="名義の種類"><Select value={form.owner_type} onChange={(e) => setForm({ ...form, owner_type: e.target.value as any })}><option value="personal">個人</option><option value="corporate">法人</option></Select></Field>
          {form.owner_type === "corporate" ? <Field label="法人名"><Input value={form.owner === "personal" ? "" : form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} /></Field> : <div />}
          <Field label="資産区分"><Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as AssetCategory })} data-testid="account-category">{ASSET_CATEGORIES.map((k) => <option key={k} value={k}>{ASSET_CATEGORY_LABELS[k]}</option>)}</Select></Field>
          <Field label="通貨" hint="JPY以外は数量×レートで円換算"><Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field>
          <Field label="単位（任意）" hint="例: USD, BTC, 口"><Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></Field>
          <Field label="取得元"><Select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value as any })}><option value="manual">手入力</option><option value="freee" disabled={!fs?.connected}>freee銀行同期</option></Select></Field>
          {form.source === "freee" && <>
            <Field label="freee事業所"><Select value={form.freee_company_id} onChange={(e) => setForm({ ...form, freee_company_id: e.target.value, freee_walletable_id: "" })}><option value="">選択</option>{fs?.companies.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}</Select></Field>
            <Field label="反映する口座"><Select value={form.freee_walletable_id} onChange={(e) => setForm({ ...form, freee_walletable_id: e.target.value })}><option value="">選択</option>{wallets.map((w) => <option key={w.id} value={String(w.id)}>{w.name}{w.last_synced_at ? `（同期 ${w.last_synced_at.slice(0, 10)}）` : "（未同期）"}</option>)}</Select></Field>
          </>}
        </div>
      </Modal>
    </div>
  );
}

/* ---------------- 使う・運用する ---------------- */
function AllocateTab() {
  const toast = useToast();
  const plan = useApi<AssetPlan>("/assets/plan");
  const alloc = useApi<Allocation>("/assets/allocation");
  const [p, setP] = useState<AssetPlan | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (plan.data && !p) setP(plan.data); }, [plan.data, p]);
  if (!p) return plan.error ? <div><ErrorBanner message={plan.error} onRetry={() => plan.reload()} testId="assets-error" /><EmptyState title="計画を取得できません" /></div> : <PageSkeleton cards={2} />;
  const numOr = (v: string) => (v === "" ? null : Number(v));
  const save = async () => { setSaving(true); try { await api.put("/assets/plan", p); toast("計画を保存しました", "success"); alloc.reload(true); } catch (e: any) { toast(e.message, "error"); } finally { setSaving(false); } };
  const a = alloc.data;
  return (
    <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
      <Card>
        <h2 className="text-lg font-semibold tracking-tight mb-1">配分の案</h2>
        <p className="text-xs text-label-2 mb-4">個人の円預金（2日以内に記録・freee同期）だけを基にします。法人資金や証券・FX・暗号資産は含めません。</p>
        {!a ? (alloc.error ? <ErrorBanner message={alloc.error} onRetry={() => alloc.reload()} className="mb-0" /> : null) : a.undetermined ? (
          <div data-testid="allocation-undetermined"><div className="text-2xl font-semibold tracking-tight">判断を保留</div><div className="text-sm text-orange mt-1">{a.reason}</div>{a.as_of && <div className="text-xs text-label-2 mt-1 tabular">最終記録 {fmtD(a.as_of)}</div>}</div>
        ) : (
          <div className="space-y-4" data-testid="allocation-result">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="守る額" value={fmtYen(a.protect)} />
              <Stat label="使う額" value={fmtYen(a.spend)} tone="accent" />
              <Stat label="運用に回す額" value={fmtYen(a.invest)} tone="green" />
            </div>
            <div className="text-xs text-label-2 space-y-0.5">
              <div className="tabular">対象の円預金 {fmtYen(a.cash)}（{fmtD(a.as_of)} 時点）</div>
              <div className="tabular">守る額の内訳: 生活費 {a.breakdown.living_months}か月分 {fmtYen(a.breakdown.living)}・予定支出 {fmtYen(a.breakdown.planned)}・負債 {fmtYen(a.breakdown.debts)}・確保 {fmtYen(a.breakdown.reserve)}</div>
              <div>案であり、送金や購入は行いません。</div>
            </div>
          </div>
        )}
      </Card>
      <Card>
        <h2 className="text-lg font-semibold tracking-tight mb-4">計画</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="毎月の生活費（円）"><Input inputMode="numeric" value={p.living_cost_monthly ?? ""} onChange={(e) => setP({ ...p, living_cost_monthly: numOr(e.target.value) })} data-testid="plan-living" /></Field>
          <Field label="確保する資金（円）"><Input inputMode="numeric" value={p.reserve_amount ?? ""} onChange={(e) => setP({ ...p, reserve_amount: numOr(e.target.value) })} data-testid="plan-reserve" /></Field>
          <Field label="次の収入日"><Input type="date" value={p.income_next?.date ?? ""} onChange={(e) => setP({ ...p, income_next: { date: e.target.value || null, amount: p.income_next?.amount ?? null } })} /></Field>
          <Field label="次の収入額（円）" hint="預金には加えません"><Input inputMode="numeric" value={p.income_next?.amount ?? ""} onChange={(e) => setP({ ...p, income_next: { date: p.income_next?.date ?? null, amount: numOr(e.target.value) } })} /></Field>
        </div>
        <ListEditor label="予定支出" items={p.planned_expenses} onChange={(items) => setP({ ...p, planned_expenses: items })} />
        <ListEditor label="負債" items={p.debts} onChange={(items) => setP({ ...p, debts: items })} />
        <div className="flex justify-end mt-4"><Button variant="primary" onClick={save} loading={saving} data-testid="plan-save">保存して再計算</Button></div>
      </Card>
    </div>
  );
}
function ListEditor({ label, items, onChange }: { label: string; items: { label: string; amount: number }[]; onChange: (v: { label: string; amount: number }[]) => void }) {
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-1"><span className="text-xs font-medium text-label-2">{label}</span><Button size="sm" variant="ghost" onClick={() => onChange([...items, { label: "", amount: 0 }])}>追加</Button></div>
      {items.length === 0 && <div className="text-xs text-label-3">なし</div>}
      <div className="space-y-2">{items.map((it, i) => (
        <div key={i} className="flex gap-2"><Input placeholder="内容" aria-label="内容" value={it.label} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /><Input inputMode="numeric" placeholder="金額" aria-label="金額（円）" className="w-36 text-right tabular" value={it.amount || ""} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) || 0 } : x)))} /><Button variant="ghost" className="text-red" aria-label={`${it.label || label}の行を削除`} onClick={() => onChange(items.filter((_, j) => j !== i))}>削除</Button></div>
      ))}</div>
    </div>
  );
}

/* ---------------- FP相談 ---------------- */
function ChatTab() {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const send = async (text: string) => {
    const next = [...msgs, { role: "user" as const, content: text }]; setMsgs(next); setBusy(true);
    try { const r = await api.post<{ reply: string; provider: string }>("/assets/chat", { history: next.map((m) => ({ role: m.role, content: m.content })) }); setMsgs([...next, { role: "assistant", content: r.reply, provider: r.provider }]); }
    catch (e: any) { setMsgs([...next, { role: "assistant", content: `エラー: ${e.message}` }]); } finally { setBusy(false); }
  };
  return <Card className="h-[70dvh]"><ChatPanel messages={msgs} onSend={send} busy={busy} placeholder="資産の配分や計画について相談…" emptyHint="保存した資産・計画・カード利用を参照して答えます。送金や購入は実行しません。" /></Card>;
}
