import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, useApi, fmtDateTime } from "@/lib/api";
import { Badge, Button, Card, Input, Skeleton, useToast } from "@/components/ui";

type ProviderStatus = { connected: boolean; connected_at: string | null; scope: string | null; expires_at: string | null; via?: "stored" | "env" };
type Status = {
  providers: { google_calendar: ProviderStatus; gmail: ProviderStatus; oura: ProviderStatus; freee: ProviderStatus };
  configured: { google: boolean; oura_env: boolean; freee: boolean };
};

const CONNECT_MESSAGES: Record<string, { text: string; tone: "success" | "error" }> = {
  google: { text: "Googleと接続しました", tone: "success" },
  google_denied: { text: "Googleの認可がキャンセルされました", tone: "error" },
  google_noscope: { text: "カレンダー・Gmailの権限が許可されませんでした", tone: "error" },
  google_error: { text: "Googleの接続に失敗しました", tone: "error" },
};

/** 設定 → 接続: Google（カレンダー・Gmail）/ Oura / freee の接続状態と操作。 */
export function IntegrationsCard() {
  const status = useApi<Status>("/integrations/status");
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const announced = useRef(false);
  useEffect(() => {
    const c = params.get("connected");
    if (!c || announced.current) return;
    announced.current = true; // StrictMode runs effects twice in dev; toast once
    const m = CONNECT_MESSAGES[c];
    if (m) toast(m.text, m.tone);
    setParams((p) => { p.delete("connected"); return p; }, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const s = status.data;
  return (
    <div data-testid="integrations-card"><Card padded={false} className="divide-y divide-separator">
      {!s && status.loading && <div className="p-5 space-y-3"><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>}
      {s && (
        <>
          <GoogleRow s={s} onChanged={() => status.reload(true)} />
          <OuraRow s={s} onChanged={() => status.reload(true)} />
          <FreeeRow s={s} />
        </>
      )}
    </Card></div>
  );
}

function Row({ title, connected, badge, children, testId }: { title: string; connected: boolean; badge?: string; children: ReactNode; testId: string }) {
  return (
    <div className="px-5 py-4 space-y-3" data-testid={testId}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">{title}</div>
        <Badge tone={connected ? "green" : "neutral"}>{badge ?? (connected ? "接続済み" : "未接続")}</Badge>
      </div>
      {children}
    </div>
  );
}

function GoogleRow({ s, onChanged }: { s: Status; onChanged: () => void }) {
  const toast = useToast();
  const cal = s.providers.google_calendar;
  const gm = s.providers.gmail;
  const any = cal.connected || gm.connected;
  const [scopes, setScopes] = useState<{ calendar: boolean; gmail: boolean }>({ calendar: !cal.connected, gmail: !gm.connected });
  const [busy, setBusy] = useState(false);
  const selected = (["calendar", "gmail"] as const).filter((k) => scopes[k]);
  const connectedAt = cal.connected_at ?? gm.connected_at;

  const connect = () => { window.location.href = `/api/integrations/google/start?scopes=${selected.join(",")}`; };
  const disconnect = async () => {
    if (!confirm("Googleの接続を解除しますか？保存したトークンを削除し、Google側でも取り消します。")) return;
    setBusy(true);
    try { await api.del("/integrations/google"); toast("Googleの接続を解除しました", "success"); onChanged(); }
    catch (e: any) { toast(e?.message ?? "解除に失敗しました", "error"); }
    finally { setBusy(false); }
  };

  return (
    <Row title="Google（カレンダー・Gmail）" connected={any} badge={any && !(cal.connected && gm.connected) ? "一部接続" : undefined} testId="integration-google">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5" data-testid="google-calendar-state"><Dot on={cal.connected} />カレンダー{cal.connected ? "" : "（未接続）"}</span>
        <span className="flex items-center gap-1.5" data-testid="google-gmail-state"><Dot on={gm.connected} />Gmail{gm.connected ? "" : "（未接続）"}</span>
      </div>
      {any && <div className="text-xs text-label-2">接続日時 <span className="tabular" data-testid="google-connected-at">{fmtDateTime(connectedAt)}</span>・読み取り専用</div>}
      {!(cal.connected && gm.connected) && (
        <div className="flex flex-wrap items-center gap-4">
          {(["calendar", "gmail"] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm select-none">
              <input type="checkbox" className="accent-[var(--accent)] size-4" checked={scopes[k]} disabled={k === "calendar" ? cal.connected : gm.connected} onChange={(e) => setScopes((p) => ({ ...p, [k]: e.target.checked }))} data-testid={`google-scope-${k}`} />
              {k === "calendar" ? "カレンダー" : "Gmail"}
            </label>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!(cal.connected && gm.connected) && (
          <Button variant="primary" size="sm" onClick={connect} disabled={!s.configured.google || selected.length === 0} data-testid="google-connect">{any ? "追加で接続する" : "接続する"}</Button>
        )}
        {any && <Button variant="ghost" size="sm" onClick={disconnect} loading={busy} data-testid="google-disconnect">解除</Button>}
      </div>
      {!s.configured.google && <p className="text-xs text-label-3" data-testid="google-unconfigured">GOOGLE_CLIENT_ID が未設定のため接続できません。Cloudflare のシークレットに設定してください（docs/MORNING_TODO.md）。</p>}
    </Row>
  );
}

function OuraRow({ s, onChanged }: { s: Status; onChanged: () => void }) {
  const toast = useToast();
  const o = s.providers.oura;
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);

  const connect = async () => {
    setBusy("connect"); setError(null);
    try { await api.post("/integrations/oura", { token: token.trim() }); setToken(""); toast("Ouraと接続しました", "success"); onChanged(); }
    catch (e: any) { setError(e?.message ?? "接続に失敗しました"); }
    finally { setBusy(null); }
  };
  const sync = async () => {
    setBusy("sync");
    try {
      const r = await api.post<{ ok: boolean; synced?: number; skipped?: string; error?: string }>("/integrations/oura/sync");
      toast(r.skipped === "no_token" ? "Ouraは未接続です" : `Ouraを同期しました（${r.synced ?? 0}日分）`, r.skipped ? "error" : "success");
    } catch (e: any) { toast(e?.message ?? "同期に失敗しました", "error"); }
    finally { setBusy(null); }
  };
  const disconnect = async () => {
    if (!confirm("Ouraの接続を解除しますか？保存したトークンを削除します。")) return;
    setBusy("disconnect");
    try { await api.del("/integrations/oura"); toast("Ouraの接続を解除しました", "success"); onChanged(); }
    catch (e: any) { toast(e?.message ?? "解除に失敗しました", "error"); }
    finally { setBusy(null); }
  };

  return (
    <Row title="Oura" connected={o.connected} badge={o.connected && o.via === "env" ? "環境変数で設定済み" : undefined} testId="integration-oura">
      {o.connected ? (
        <>
          <div className="text-xs text-label-2">
            {o.via === "env" ? "OURA_ACCESS_TOKEN（Cloudflare シークレット）のトークンを使用しています。" : <>接続日時 <span className="tabular" data-testid="oura-connected-at">{fmtDateTime(o.connected_at)}</span>・10分ごとに自動同期</>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="tinted" size="sm" onClick={sync} loading={busy === "sync"} data-testid="oura-sync">今すぐ同期</Button>
            {o.via !== "env" && <Button variant="ghost" size="sm" onClick={disconnect} loading={busy === "disconnect"} data-testid="oura-disconnect">解除</Button>}
          </div>
        </>
      ) : (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (token.trim()) connect(); }}>
          <div className="flex gap-2">
            <Input type="password" autoComplete="off" value={token} onChange={(e) => { setToken(e.target.value); setError(null); }} placeholder="Personal Access Token" aria-label="Oura Personal Access Token" data-testid="oura-token" />
            <Button type="submit" variant="primary" disabled={!token.trim()} loading={busy === "connect"} data-testid="oura-connect">接続</Button>
          </div>
          {error && <p className="text-xs text-red" role="alert" data-testid="oura-error">{error}</p>}
          <p className="text-xs text-label-3">Oura Cloud（cloud.ouraring.com → Personal Access Tokens）で発行したトークンを貼り付けます。保存前にOura APIで検証し、暗号化して保存します。</p>
        </form>
      )}
    </Row>
  );
}

function FreeeRow({ s }: { s: Status }) {
  const f = s.providers.freee;
  return (
    <Row title="freee" connected={f.connected} testId="integration-freee">
      <div className="text-xs text-label-2">
        {f.connected ? <>接続日時 <span className="tabular">{fmtDateTime(f.connected_at)}</span>・銀行同期残高を約1時間ごとに読み取り</> : s.configured.freee ? "未接続です。" : "FREEE_CLIENT_ID / FREEE_CLIENT_SECRET が未設定のため接続できません。"}
      </div>
      <Link to="/assets?tab=accounts" className="text-sm text-accent hover:underline" data-testid="freee-link">資産 → 口座 で{f.connected ? "管理する" : "接続する"} →</Link>
    </Row>
  );
}

function Dot({ on }: { on: boolean }) {
  return <span aria-hidden className={`inline-block size-2 rounded-full ${on ? "bg-green" : "bg-fill-strong"}`} />;
}
