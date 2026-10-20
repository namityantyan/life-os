import { useState } from "react";
import { Badge, Button, Card, ChatPanel, Skeleton, useToast, type ChatMsg } from "@/components/ui";
import { api, useApi, fmtDateTime } from "@/lib/api";

type Status = {
  configured: { publicKey: boolean; applicationId: boolean; botToken: boolean };
  ready: boolean;
  interactions_url: string;
  invite_url: string | null;
  link: { discord_user_id: string; created_at: string } | null;
  channels: { guild_id: string; channel_id: string; updated_at: string }[];
  commands: { name: string; description: string; options: string[] }[];
  has_history: boolean;
  gateway_note: string;
};
type LinkCode = { code: string; expires_at: string; command: string };
type Simulate = { message: string; provider?: string; action: string };

/**
 * Self-contained "Discord BOT" card embedded in the settings page.
 * Shows configuration/link status, issues one-time link codes, registers slash commands,
 * and previews the bot through POST /api/discord/simulate (same handler as /chat).
 */
export function DiscordSettingsCard() {
  const toast = useToast();
  const { data, loading, reload } = useApi<Status>("/discord/status");
  const [code, setCode] = useState<LinkCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [chatBusy, setChatBusy] = useState(false);

  const issueCode = async () => {
    setBusy("code");
    try { setCode(await api.post<LinkCode>("/discord/link-code")); } catch (e: any) { toast(e?.message ?? "発行に失敗しました", "error"); } finally { setBusy(null); }
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast("コピーしました", "success"); } catch { toast("コピーできませんでした", "error"); }
  };
  const register = async () => {
    setBusy("register");
    try { const r = await api.post<{ ok: boolean; count: number }>("/discord/register-commands"); toast(`コマンドを登録しました（${r.count}件）`, "success"); }
    catch (e: any) { toast(e?.message ?? "登録に失敗しました", "error"); } finally { setBusy(null); }
  };
  const unlink = async () => {
    setBusy("unlink");
    try { await api.del("/discord/link"); toast("連携を解除しました"); await reload(true); } catch (e: any) { toast(e?.message ?? "解除に失敗しました", "error"); } finally { setBusy(null); }
  };
  const resetHistory = async () => {
    setBusy("reset");
    try { await api.post("/discord/reset"); setMsgs([]); toast("会話履歴をリセットしました"); await reload(true); } catch (e: any) { toast(e?.message ?? "失敗しました", "error"); } finally { setBusy(null); }
  };
  const send = async (text: string) => {
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setChatBusy(true);
    try { const r = await api.post<Simulate>("/discord/simulate", { text }); setMsgs((m) => [...m, { role: "assistant", content: r.message, provider: r.provider }]); }
    catch (e: any) { setMsgs((m) => [...m, { role: "assistant", content: `エラー: ${e?.message ?? e}` }]); }
    finally { setChatBusy(false); }
  };

  if (loading && !data) return <Skeleton className="h-40" />;
  if (!data) return null;
  const conf = data.configured;

  return (
    <div data-testid="discord-card"><Card className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-semibold">Discord BOT</h3>
          <p className="text-xs text-label-2 mt-0.5">スラッシュコマンド（Interactions）方式。通知はDMで届きます。</p>
        </div>
        <Badge tone={data.ready ? "green" : "orange"} className="self-center">{data.ready ? "設定済み" : "未設定の項目あり"}</Badge>
      </div>

      <div className="grid sm:grid-cols-3 gap-2 text-sm">
        {([["publicKey", "DISCORD_PUBLIC_KEY"], ["applicationId", "DISCORD_APPLICATION_ID"], ["botToken", "DISCORD_BOT_TOKEN"]] as const).map(([k, l]) => (
          <div key={k} className="flex items-center justify-between rounded-[var(--radius-md)] bg-fill px-3 py-2"><span className="text-xs font-mono truncate">{l}</span><Badge tone={conf[k] ? "green" : "neutral"}>{conf[k] ? "あり" : "なし"}</Badge></div>
        ))}
      </div>

      <div className="space-y-1 text-sm">
        <div className="text-xs text-label-2 font-medium">Interactions Endpoint URL</div>
        <div className="flex items-center gap-2"><code className="text-xs bg-fill rounded-[var(--radius-md)] px-2 py-1 break-all flex-1">{data.interactions_url}</code><Button size="sm" variant="ghost" onClick={() => copy(data.interactions_url)}>コピー</Button></div>
        {data.invite_url && <a className="text-xs text-accent" href={data.invite_url} target="_blank" rel="noreferrer">BOTをサーバーに招待（bot + applications.commands）</a>}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm">
            <span className="text-xs text-label-2 font-medium block">アカウント連携</span>
            {data.link ? <span data-testid="discord-linked">Discordユーザー <code className="text-xs">{data.link.discord_user_id}</code>（{fmtDateTime(data.link.created_at)}）</span> : <span className="text-label-2">未連携</span>}
          </div>
          <div className="flex gap-2">
            {data.link && <Button size="sm" variant="danger" loading={busy === "unlink"} onClick={unlink} data-testid="discord-unlink">解除</Button>}
            <Button size="sm" variant="tinted" loading={busy === "code"} onClick={issueCode} data-testid="discord-link-code">連携コードを発行</Button>
          </div>
        </div>
        {code && (
          <div className="rounded-[var(--radius-md)] bg-accent-soft px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-2xl font-semibold tracking-[0.2em] tabular" data-testid="discord-code">{code.code}</div>
              <div className="text-xs text-label-2 mt-0.5">Discordで <code>{code.command}</code> を実行（{fmtDateTime(code.expires_at)} まで有効）</div>
            </div>
            <Button size="sm" onClick={() => copy(code.command)} data-testid="discord-code-copy">コマンドをコピー</Button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2 text-sm">
        <div>
          <span className="text-xs text-label-2 font-medium block">スラッシュコマンド</span>
          <span className="text-label-2 text-xs">{data.commands.map((c) => `/${c.name}`).join("  ")}</span>
        </div>
        <Button size="sm" loading={busy === "register"} disabled={!conf.applicationId || !conf.botToken} onClick={register} data-testid="discord-register">コマンドを登録</Button>
      </div>

      {data.channels.length > 0 && (
        <div className="text-sm">
          <span className="text-xs text-label-2 font-medium block">会話用チャンネル</span>
          <ul className="text-xs text-label-2 space-y-0.5">{data.channels.map((ch) => <li key={ch.guild_id}>guild {ch.guild_id} → channel {ch.channel_id}（{fmtDateTime(ch.updated_at)}）</li>)}</ul>
        </div>
      )}

      <p className="text-xs text-label-2">{data.gateway_note}</p>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-label-2 font-medium">BOTを試す（/chat と同じ処理）</span>
          <Button size="sm" variant="ghost" loading={busy === "reset"} onClick={resetHistory} data-testid="discord-reset">履歴をリセット</Button>
        </div>
        <div className="rounded-[var(--radius-lg)] bg-subtle p-3" data-testid="discord-preview">
          <ChatPanel messages={msgs} onSend={send} busy={chatBusy} placeholder="例: 資産のURL / 今日の調子は？" emptyHint="ここで送ったメッセージはDiscordの /chat と同じように処理されます。" />
        </div>
      </div>
    </Card></div>
  );
}
