import { useEffect, useState } from "react";
import { NOTIFICATION_KIND_LABELS } from "@shared/types";
import { NOTIFICATION_MODULES, deviceLabel, normalizePushPrefs, withKind, withModule, type PushPrefs } from "@shared/notifications";
import { api, useApi, fmtDateTime } from "@/lib/api";
import { currentSubscription, disablePush, enablePush, isIos, isStandalone, pushPermission, type PushPermission } from "@/lib/push";
import { Badge, Button, Card, Section, Skeleton, Toggle, useToast, cx } from "@/components/ui";

type Sub = { id: string; endpoint: string; user_agent: string | null; label: string | null; last_ok_at: string | null; last_error: string | null; stale: boolean; created_at: string };
type TestResult = { id: string; ok: boolean; status: number | null; removed: boolean; error: string | null };
type Morning = { oura: boolean; events: boolean; tasks: boolean; meals: boolean };

/** How to undo a blocked permission, per platform. */
function deniedHelp(): string {
  const ua = navigator.userAgent;
  if (isIos()) return "設定アプリ → 通知 → Life OS で「通知を許可」をオンにしてください。";
  if (/Android/.test(ua)) return isStandalone() ? "Life OSのアイコンを長押し → アプリ情報 → 通知 をオンにしてください。" : "アドレスバー左のアイコン → 権限 → 通知 を「許可」にして、ページを再読み込みしてください。";
  const mac = /Macintosh/.test(ua);
  const safari = /Safari\//.test(ua) && !/(Chrome|Edg|Firefox)\//.test(ua);
  const site = safari ? (isStandalone() ? "システム設定 → 通知 → Life OS をオンにしてください。" : "Safari → 設定 → Webサイト → 通知 で、このサイトを「許可」にしてください。") : "アドレスバー左のアイコン → サイトの設定 → 通知 を「許可」にして、ページを再読み込みしてください。";
  return mac && !safari ? `${site} あわせて macOS の「システム設定 → 通知」でブラウザの通知がオンになっているか確認してください。` : site;
}

/** 設定 → 通知: this device's push, registered devices, and per-module push switches. The bell always records everything. */
export function NotificationsSection() {
  const toast = useToast();
  const st = useApi<{ settings: Record<string, any>; vapidPublicKey: string | null }>("/settings");
  const subs = useApi<{ items: Sub[] }>("/push/subscriptions");
  const [perm, setPerm] = useState<PushPermission>(() => pushPermission());
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PushPrefs | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [morning, setMorning] = useState<Morning>({ oura: true, events: true, tasks: true, meals: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});

  const refreshDevice = () => { setPerm(pushPermission()); currentSubscription().then((s) => setEndpoint(s?.endpoint ?? null)).catch(() => setEndpoint(null)); };
  useEffect(() => { refreshDevice(); const f = () => document.visibilityState === "visible" && refreshDevice(); document.addEventListener("visibilitychange", f); return () => document.removeEventListener("visibilitychange", f); }, []);
  useEffect(() => { if (!st.data) return; setPrefs(normalizePushPrefs(st.data.settings.push_prefs)); if (st.data.settings.morning_contents) setMorning(st.data.settings.morning_contents); }, [st.data]);

  const key = st.data?.vapidPublicKey ?? null;
  const items = subs.data?.items ?? [];
  const registered = Boolean(endpoint && items.some((s) => s.endpoint === endpoint));

  const enable = async () => {
    if (!key) return;
    setBusy("enable");
    try {
      const p = await enablePush(key);
      if (p === "granted") toast("この端末で通知を受け取ります", "success"); else if (p === "denied") toast("通知がブロックされています", "error");
    } catch (e: any) { toast(e?.message ?? "登録に失敗しました", "error"); }
    finally { setBusy(null); refreshDevice(); subs.reload(true); }
  };
  const disable = async () => { setBusy("disable"); try { await disablePush(); toast("この端末の通知を解除しました"); } finally { setBusy(null); refreshDevice(); subs.reload(true); } };
  const test = async () => {
    setBusy("test");
    try {
      const r = await api.post<{ pushConfigured: boolean; results: TestResult[] }>("/notifications/test");
      setTests(Object.fromEntries(r.results.map((x) => [x.id, x])));
      const ok = r.results.filter((x) => x.ok).length;
      toast(!r.pushConfigured ? "ベルに記録しました（サーバーの鍵が未設定）" : r.results.length === 0 ? "ベルに記録しました（登録済みの端末なし）" : `${r.results.length}台中${ok}台に送信しました`, ok || !r.results.length ? "success" : "error");
    } catch (e: any) { toast(e?.message ?? "送信に失敗しました", "error"); }
    finally { setBusy(null); subs.reload(true); }
  };
  const remove = async (s: Sub, name: string) => {
    if (!confirm(`「${name}」の通知登録を解除しますか？`)) return;
    if (s.endpoint === endpoint) await disablePush(); else await api.post("/push/unsubscribe", { id: s.id });
    toast("解除しました"); refreshDevice(); subs.reload(true);
  };
  const save = async (next: PushPrefs) => { setPrefs(next); try { await api.put("/settings/push_prefs", next); } catch (e: any) { toast(e?.message ?? "保存に失敗しました", "error"); st.reload(true); } };

  const status = !key ? { tone: "neutral" as const, text: "サーバー未設定" }
    : perm === "granted" ? (registered ? { tone: "green" as const, text: "受信中" } : { tone: "orange" as const, text: "未登録" })
    : perm === "denied" ? { tone: "red" as const, text: "ブロック中" }
    : perm === "default" ? { tone: "neutral" as const, text: "未登録" } : { tone: "neutral" as const, text: "非対応" };

  return (
    <Section title="通知" className="scroll-mt-20"><div id="notifications" />
      <Card className="space-y-3" data-testid="push-device">
        <div className="flex items-center justify-between gap-3"><div className="text-sm font-medium">この端末</div><Badge tone={status.tone}>{status.text}</Badge></div>
        {!key ? <p className="text-xs text-label-2">サーバーにプッシュ通知の鍵（VAPID）が設定されていません。</p>
          : perm === "needs-install" ? <p className="text-xs text-label-2">iPhone・iPadでは、Safariの共有メニューから「ホーム画面に追加」し、追加したLife OSから開いてください。</p>
          : perm === "unsupported" ? <p className="text-xs text-label-2">このブラウザはプッシュ通知に対応していません。</p>
          : perm === "denied" ? <><p className="text-xs text-label-2" data-testid="push-denied-help">通知がブロックされています。{deniedHelp()}</p><Button size="sm" onClick={refreshDevice}>状態を再確認</Button></>
          : (
            <div className="flex gap-2 flex-wrap">
              {registered ? <Button size="sm" variant="ghost" loading={busy === "disable"} onClick={disable} data-testid="disable-device">この端末を解除</Button>
                : <Button variant="primary" loading={busy === "enable"} onClick={enable} data-testid="enable-device">この端末で通知を受け取る</Button>}
            </div>
          )}
        {perm !== "denied" && <p className="text-xs text-label-2">Mac・Androidはブラウザのままでも、ホーム画面やDockに追加したアプリでも受け取れます。登録はブラウザ・アプリごとに必要です。</p>}
      </Card>

      <Card padded={false} data-testid="push-devices">
        <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-b border-separator"><span className="text-xs font-medium text-label-2">登録済みの端末</span><Button size="sm" variant="tinted" loading={busy === "test"} onClick={test} data-testid="send-test-notification">テスト通知を送る</Button></div>
        {subs.loading && !subs.data && <div className="p-4"><Skeleton className="h-10" /></div>}
        {subs.data && items.length === 0 && <div className="px-5 py-4 text-sm text-label-3">まだありません</div>}
        <ul className="divide-y divide-separator">
          {items.map((s) => {
            const name = s.label ?? deviceLabel(s.user_agent ?? "");
            const t = tests[s.id];
            const line = t ? (t.ok ? "テスト通知を送信しました" : `送信できませんでした${t.error ? `（${t.error}）` : ""}`)
              : s.stale ? "サーバーの鍵が変わりました。その端末でLife OSを開くと再登録されます。"
              : s.last_error ? `最後の送信に失敗: ${s.last_error}` : s.last_ok_at ? `最終送信 ${fmtDateTime(s.last_ok_at)}` : `登録 ${fmtDateTime(s.created_at)}`;
            return (
              <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3" data-testid="push-device-row">
                <div className="min-w-0">
                  <div className="text-sm flex items-center gap-2">{name}{s.endpoint === endpoint && <Badge tone="accent">この端末</Badge>}</div>
                  <div className={cx("text-xs truncate", (t && !t.ok) || s.stale || (!t && s.last_error) ? "text-red" : "text-label-2")}>{line}</div>
                </div>
                <Button size="sm" variant="danger" aria-label={`${name}の通知を解除`} onClick={() => remove(s, name)}>解除</Button>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card padded={false} data-testid="push-modules">
        <div className="px-5 py-3 border-b border-separator"><div className="text-xs font-medium text-label-2">端末に送る通知</div><div className="text-xs text-label-3 mt-0.5">オフにしても、ベルの一覧には記録されます。</div></div>
        {!prefs ? <div className="p-4"><Skeleton className="h-40" /></div> : NOTIFICATION_MODULES.map((m) => {
          const many = m.kinds.length > 1;
          const expanded = open === m.key;
          return (
            <div key={m.key} className="border-b border-separator last:border-0" data-testid={`push-module-${m.key}`}>
              <div className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm">{m.label}</span>
                  {many && <button type="button" className="focus-ring rounded-[var(--radius-sm)] text-xs text-accent" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : m.key)}>{expanded ? "閉じる" : `${m.kinds.length}種類`}</button>}
                </div>
                <Toggle checked={prefs.modules[m.key]} onChange={(v) => save(withModule(prefs, m.key, v))} label={`${m.label}の通知`} />
              </div>
              {many && expanded && m.kinds.map((k) => (
                <div key={k} className="flex items-center justify-between gap-3 pl-9 pr-5 py-2.5 bg-subtle" data-testid={`push-kind-${k}`}>
                  <span className={cx("text-sm", !prefs.modules[m.key] && "text-label-3")}>{NOTIFICATION_KIND_LABELS[k]}</span>
                  <Toggle checked={prefs.modules[m.key] && prefs.kinds[k]} onChange={(v) => save(withKind(prefs, k, v))} label={`${NOTIFICATION_KIND_LABELS[k]}の通知`} />
                </div>
              ))}
            </div>
          );
        })}
      </Card>

      <Card className="space-y-3">
        <div className="text-sm font-medium">朝のお知らせに含める内容</div>
        <div className="flex flex-wrap gap-4">
          {([["oura", "Oura"], ["events", "予定"], ["tasks", "タスク"], ["meals", "食事"]] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 text-sm"><Toggle checked={morning[k]} onChange={async (v) => { const n = { ...morning, [k]: v }; setMorning(n); await api.put("/settings/morning_contents", n); }} label={l} />{l}</label>
          ))}
        </div>
      </Card>
    </Section>
  );
}
