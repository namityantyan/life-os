import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { NotificationPrefs, WeatherLocation } from "@shared/types";
import { NOTIFICATION_KINDS, NOTIFICATION_KIND_LABELS } from "@shared/types";
import { api, useApi } from "@/lib/api";
import { useTheme } from "@/app/theme";
import { Badge, Button, Card, Field, Input, PageHeader, PageSkeleton, Section, Segmented, Toggle, useToast, Skeleton, ErrorBanner } from "@/components/ui";
import { IntegrationsCard } from "./IntegrationsCard";
import { DataCard } from "./DataCard";
import { AppearanceCard } from "./AppearanceCard";
import { TabBarCard } from "./TabBarCard";

const DiscordCard = lazy(() => import("@/modules/discord/SettingsCard").then((m) => ({ default: m.DiscordSettingsCard })).catch(() => ({ default: () => null })));

type SettingsRes = { settings: Record<string, any>; vapidPublicKey: string | null; integrations: Record<string, boolean> };

function urlB64ToU8(b64: string) { const pad = "=".repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); }

export default function Page() {
  const { data, loading, error, reload } = useApi<SettingsRes>("/settings");
  const subs = useApi<{ items: { id: string; endpoint: string; user_agent: string | null; label: string | null; enabled: number; created_at: string }[] }>("/push/subscriptions");
  const toast = useToast();
  const loc = useLocation();
  const { prefs, setPrefs } = useTheme();
  const [geoQ, setGeoQ] = useState("");
  const [geo, setGeo] = useState<WeatherLocation[]>([]);
  const [morning, setMorning] = useState({ oura: true, events: true, tasks: true, meals: false });
  useEffect(() => { if (data?.settings.morning_contents) setMorning(data.settings.morning_contents); }, [data]);
  useEffect(() => { if (loc.hash && data) setTimeout(() => document.querySelector(loc.hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }, [loc.hash, data]);
  if (loading && !data) return <PageSkeleton cards={4} />;
  if (!data) return <div><PageHeader title="設定" /><ErrorBanner message={error} onRetry={() => reload()} testId="settings-error" /></div>;
  const prefsN: NotificationPrefs = data.settings.notification_prefs;
  const weather: WeatherLocation | null = data.settings.weather_location ?? null;

  const setPref = async (kind: string, ch: "push" | "discord", v: boolean) => {
    const next = { ...prefsN, [kind]: { ...prefsN[kind as keyof NotificationPrefs], [ch]: v } };
    await api.put("/settings/notification_prefs", next); reload(true);
  };
  const search = async () => { const r = await api.get<{ items: WeatherLocation[] }>(`/weather/geocode?q=${encodeURIComponent(geoQ)}`); setGeo(r.items); };
  const pick = async (l: WeatherLocation) => { await api.put("/settings/weather_location", l); setGeo([]); setGeoQ(""); toast(`${l.name} に設定しました`, "success"); reload(true); };
  const enableDevice = async () => {
    try {
      if (!data.vapidPublicKey) { toast("プッシュ通知の鍵（VAPID）が未設定です", "error"); return; }
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) { toast("この端末はWeb Pushに対応していません", "error"); return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("OSの通知が許可されていません", "error"); return; }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(data.vapidPublicKey) });
      const j = sub.toJSON();
      await api.post("/push/subscribe", { endpoint: j.endpoint, keys: j.keys, label: navigator.platform });
      toast("この端末の通知をONにしました", "success"); subs.reload(true);
    } catch (e: any) { toast(e?.message ?? "登録に失敗しました", "error"); }
  };
  const testNotify = async () => { const r = await api.post<{ delivery: { sent: number }; pushConfigured: boolean }>("/notifications/test"); toast(r.pushConfigured ? `送信しました（配信 ${r.delivery.sent}件）` : "アプリ内通知を作成しました（プッシュ鍵未設定）", "success"); };

  return (
    <div className="space-y-10 max-w-3xl">
      <PageHeader title="設定" />

      <Section title="表示" className="scroll-mt-20"><div id="display" />
        <Card className="space-y-5">
          <AppearanceCard />
          <Slider label="文字サイズ" value={prefs.fontScale} min={0.85} max={1.3} step={0.05} onChange={(v) => setPrefs({ fontScale: v })} testId="font-scale" />
          <Slider label="余白" value={prefs.spaceScale} min={0.8} max={1.3} step={0.05} onChange={(v) => setPrefs({ spaceScale: v })} testId="space-scale" />
          <Slider label="角丸" value={prefs.radiusScale} min={0.5} max={1.5} step={0.1} onChange={(v) => setPrefs({ radiusScale: v })} />
          <div className="flex items-center justify-between"><span className="text-sm">アニメーションを減らす</span><Toggle checked={prefs.reduceMotion} onChange={(v) => setPrefs({ reduceMotion: v })} label="アニメーションを減らす" /></div>
          <Button variant="ghost" size="sm" onClick={() => setPrefs({ fontScale: 1, spaceScale: 1, radiusScale: 1 })}>標準に戻す</Button>
        </Card>
        <Card className="space-y-3 scroll-mt-20"><div id="tabbar" /><div className="text-sm font-medium">下のバー（スマホ）</div><TabBarCard /></Card>
      </Section>

      <Section title="通知" className="scroll-mt-20"><div id="notifications" />
        <Card padded={false}>
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 px-5 py-3 text-xs font-medium text-label-2 border-b border-separator"><span>種類</span><span className="w-12 text-center">スマホ</span><span className="w-12 text-center">Discord</span></div>
          {NOTIFICATION_KINDS.map((k) => (
            <div key={k} className="grid grid-cols-[1fr_auto_auto] gap-x-6 items-center px-5 py-3 border-b border-separator last:border-0" data-testid={`pref-${k}`}>
              <span className="text-sm">{NOTIFICATION_KIND_LABELS[k]}</span>
              <div className="w-12 flex justify-center"><Toggle checked={prefsN[k]?.push ?? true} onChange={(v) => setPref(k, "push", v)} label={`${NOTIFICATION_KIND_LABELS[k]} スマホ`} /></div>
              <div className="w-12 flex justify-center"><Toggle checked={prefsN[k]?.discord ?? false} onChange={(v) => setPref(k, "discord", v)} label={`${NOTIFICATION_KIND_LABELS[k]} Discord`} /></div>
            </div>
          ))}
        </Card>
        <Card className="space-y-3">
          <div className="text-sm font-medium">朝のお知らせに含める内容</div>
          <div className="flex flex-wrap gap-4">
            {([["oura", "Oura"], ["events", "予定"], ["tasks", "タスク"], ["meals", "食事"]] as const).map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 text-sm"><Toggle checked={morning[k]} onChange={async (v) => { const n = { ...morning, [k]: v }; setMorning(n); await api.put("/settings/morning_contents", n); }} label={l} />{l}</label>
            ))}
          </div>
        </Card>
        <Card className="space-y-3"><div id="devices" />
          <div className="flex items-center justify-between"><div className="text-sm font-medium">スマホの端末設定</div><Badge tone={data.integrations.push ? "green" : "neutral"}>{data.integrations.push ? "鍵設定済み" : "VAPID未設定"}</Badge></div>
          <p className="text-xs text-label-2">種類のON/OFFとは別に、受け取る端末ごとに登録が必要です。iPhone/iPadはホーム画面に追加したLife OSから行ってください。</p>
          <div className="flex gap-2 flex-wrap"><Button variant="primary" onClick={enableDevice} data-testid="enable-device">この端末の通知をON</Button><Button onClick={testNotify} data-testid="send-test-notification">テスト通知を送る</Button></div>
          <ul className="divide-y divide-separator">
            {subs.loading && <Skeleton className="h-10" />}
            {(subs.data?.items ?? []).map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm"><span className="truncate text-label-2 min-w-0">{s.label ?? "端末"} · {s.user_agent?.slice(0, 40) ?? ""}</span>
                {s.enabled ? <Button size="sm" variant="danger" aria-label={`${s.label ?? "端末"}の通知を解除`} onClick={async () => { if (!confirm(`「${s.label ?? "端末"}」の通知登録を解除しますか？`)) return; await api.post("/push/unsubscribe", { id: s.id }); subs.reload(true); toast("解除しました"); }}>解除</Button> : <Badge>解除済み</Badge>}</li>
            ))}
          </ul>
        </Card>
      </Section>

      <Section title="天気・体調" className="scroll-mt-20"><div id="weather" />
        <Card className="space-y-3">
          <div className="text-sm">現在の地域: <span className="font-medium" data-testid="weather-location">{weather?.name ?? "未設定"}</span></div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); search(); }}>
            <Input value={geoQ} onChange={(e) => setGeoQ(e.target.value)} placeholder="市区町村名（例: 渋谷区）" data-testid="geo-input" />
            <Button type="submit" variant="tinted" data-testid="geo-search">検索</Button>
          </form>
          {geo.length > 0 && <ul className="space-y-1" aria-label="検索結果">{geo.map((g) => <li key={`${g.lat},${g.lon}`}><button type="button" className="focus-ring w-full text-left px-3 py-2.5 rounded-[var(--radius-md)] hover:bg-fill text-sm" onClick={() => pick(g)} data-testid="geo-result">{g.name}</button></li>)}</ul>}
          <p className="text-xs text-label-2">気圧の判定基準: 3時間で2.5/4.0 hPa、6時間で4.0/6.0 hPa、期間内の幅5.0/8.0 hPa（注意/強い変化）。</p>
        </Card>
      </Section>

      <Section title="接続" className="scroll-mt-20"><div id="integrations" />
        <Card padded={false}>
          {([["google", "Google（ログイン・カレンダー・Gmail）"], ["oura", "Oura"], ["freee", "freee"], ["discord", "Discord"], ["push", "Web Push（VAPID）"], ["backups", "バックアップ受信トークン"], ["fx", "FXコネクタートークン"]] as const).map(([k, l]) => (
            <div key={k} className="flex items-center justify-between px-5 py-3 border-b border-separator last:border-0 text-sm"><span>{l}</span><Badge tone={data.integrations[k] ? "green" : "neutral"}>{data.integrations[k] ? "設定済み" : "未設定"}</Badge></div>
          ))}
        </Card>
        <p className="text-xs text-label-2 px-1">各サービスの鍵はCloudflareのシークレットとして保存します（画面やログには出しません）。設定手順は README を参照。</p>
        <IntegrationsCard />
        <Suspense fallback={<Skeleton className="h-32" />}><DiscordCard /></Suspense>
      </Section>

      <Section title="データ" className="scroll-mt-20"><div id="data" />
        <DataCard />
      </Section>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, testId }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; testId?: string }) {
  return (
    <label className="block">
      <div className="flex justify-between text-sm"><span>{label}</span><span className="tabular text-label-2">{Math.round(value * 100)}%</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)] mt-2" data-testid={testId} aria-label={label} />
    </label>
  );
}
