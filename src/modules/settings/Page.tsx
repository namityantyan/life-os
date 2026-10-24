import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { WeatherLocation } from "@shared/types";
import { api, useApi } from "@/lib/api";
import { useTheme } from "@/app/theme";
import { Badge, Button, Card, Field, Input, PageHeader, PageSkeleton, Section, Segmented, Toggle, useToast, ErrorBanner } from "@/components/ui";
import { IntegrationsCard } from "./IntegrationsCard";
import { DataCard } from "./DataCard";
import { NotificationsSection } from "./NotificationsCard";
import { AppearanceCard } from "./AppearanceCard";
import { TabBarCard } from "./TabBarCard";

type SettingsRes = { settings: Record<string, any>; vapidPublicKey: string | null; integrations: Record<string, boolean> };

export default function Page() {
  const { data, loading, error, reload } = useApi<SettingsRes>("/settings");
  const toast = useToast();
  const loc = useLocation();
  const { prefs, setPrefs } = useTheme();
  const [geoQ, setGeoQ] = useState("");
  const [geo, setGeo] = useState<WeatherLocation[]>([]);
  useEffect(() => { if (loc.hash && data) setTimeout(() => document.querySelector(loc.hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }, [loc.hash, data]);
  if (loading && !data) return <PageSkeleton cards={4} />;
  if (!data) return <div><PageHeader title="設定" /><ErrorBanner message={error} onRetry={() => reload()} testId="settings-error" /></div>;
  const weather: WeatherLocation | null = data.settings.weather_location ?? null;

  const search = async () => { const r = await api.get<{ items: WeatherLocation[] }>(`/weather/geocode?q=${encodeURIComponent(geoQ)}`); setGeo(r.items); };
  const pick = async (l: WeatherLocation) => { await api.put("/settings/weather_location", l); setGeo([]); setGeoQ(""); toast(`${l.name} に設定しました`, "success"); reload(true); };

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

      <NotificationsSection />

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
          {([["google", "Google（ログイン・カレンダー・Gmail）"], ["oura", "Oura"], ["freee", "freee"], ["push", "Web Push（VAPID）"], ["backups", "バックアップ受信トークン"], ["fx", "FXコネクタートークン"]] as const).map(([k, l]) => (
            <div key={k} className="flex items-center justify-between px-5 py-3 border-b border-separator last:border-0 text-sm"><span>{l}</span><Badge tone={data.integrations[k] ? "green" : "neutral"}>{data.integrations[k] ? "設定済み" : "未設定"}</Badge></div>
          ))}
        </Card>
        <p className="text-xs text-label-2 px-1">各サービスの鍵はCloudflareのシークレットとして保存します（画面やログには出しません）。設定手順は README を参照。</p>
        <IntegrationsCard />
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
