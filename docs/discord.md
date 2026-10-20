# Discord BOT（生活管理BOT）

Life OS の Discord 連携は **Discord Interactions（HTTP エンドポイント + スラッシュコマンド）** と、
DM 送信用の outbound REST で構成されています。

## 構成と制約（重要）

| 方式 | 使えるか | 備考 |
| --- | --- | --- |
| スラッシュコマンド（`/chat` など） | 使える | Discord が `POST <origin>/api/integrations/discord/interactions` に署名付きで送信 |
| 通知の DM | 使える | `worker/core/notify.ts` の `sendDiscord` が Bot Token で連携ユーザーへ DM |
| メンション・通常発言への反応 | **使えない** | Gateway（WebSocket 常駐）が必要。Cloudflare Workers は常駐接続を保持できない |
| 「会話用チャンネルではメンション不要」 | **使えない** | 同上。`/chathere` の設定は保存されるが、通常発言は受信できない |

元の SPEC（§15）にある `!chat here` / メンション会話は、常駐プロセス（PM2 の Python BOT）を前提にしていました。
Workers 版では **会話の入口は `/chat <text>`** です。自然文での記録（筋トレなど）も `/chat` から同じハンドラを通ります。
将来 Gateway に対応する場合は、別ホスト（VPS や Durable Object + 外部プロセス）で WebSocket を張り、受信したメッセージを
`POST /api/discord/simulate` 相当の内部ハンドラ（`worker/modules/discord/service.ts` の `handleMessage`）に流す設計にできます。

## セットアップ手順

1. **Discord アプリを作成**: <https://discord.com/developers/applications> → New Application。
2. **General Information** から `APPLICATION ID` と `PUBLIC KEY` を控える。
3. **Bot** タブで Bot を追加し、`Reset Token` でトークンを取得（一度しか表示されない）。
   - Privileged Gateway Intents は不要（Gateway を使わないため）。
4. **シークレットを設定**（本番）:
   ```sh
   wrangler secret put DISCORD_PUBLIC_KEY --env production
   wrangler secret put DISCORD_APPLICATION_ID --env production
   wrangler secret put DISCORD_BOT_TOKEN --env production
   ```
   ローカルは `.dev.vars` に同名で記述（`DISCORD_PUBLIC_KEY=...`）。
5. **スラッシュコマンドを登録**: 設定画面の「Discord BOT」カードで「コマンドを登録」を押す
   （`POST /api/discord/register-commands` → `PUT /applications/{id}/commands` で一括上書き）。グローバルコマンドの反映には最大 1 時間かかることがあります。
6. **Interactions Endpoint URL を設定**: General Information →
   `Interactions Endpoint URL` に `<origin>/api/integrations/discord/interactions`
   （例: `https://life-os.example.workers.dev/api/integrations/discord/interactions`）を入力して保存。
   Discord が PING（type 1）を送り、署名検証と PONG 応答が通れば保存できます。先にデプロイ済みであること。
7. **サーバーへ招待**: 設定カードの招待リンク、または
   `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot%20applications.commands&permissions=2048`
   （scopes: `bot`, `applications.commands`。permissions 2048 = Send Messages）。DM 通知だけなら招待なしでも、
   共通サーバーがあるか DM が許可されていれば届きます。
8. **アカウント連携**: 設定画面で「連携コードを発行」→ Discord で `/link code:XXXXXX`（10 分有効、1 回限り）。
   コードは KV の `discord:link:<code>` → userId に保存されます。連携後に通知設定の「Discord」を ON にすると DM が届きます。

## コマンド一覧

| コマンド | 内容 |
| --- | --- |
| `/chat text:<内容>` | 生活管理BOTとの会話。睡眠・トレーニング・予定・お金・メモ（Life Context）を踏まえて回答。「資産のURL」などは画面リンクを返し、筋トレの文（「ベンチ 60kg 10回 3セット」など）はトレーニング記録（`training/nlp.ts` の `logFromText`）を先に試す。応答は deferred（type 5）→ webhook で完了 |
| `/dash [module]` | 画面リンク。`module` は「資産」「training」など（省略時はダッシュボード） |
| `/dashboard` | ダッシュボードのリンク |
| `/chathere` | 実行したチャンネルをこのサーバーの会話用チャンネルとして保存（`discord_channels`）。※上記制約により通常発言は受信できない |
| `/chatstatus` | 会話用チャンネルの確認 |
| `/chatoff` | 会話用チャンネルの解除（会話履歴は残る） |
| `/link code:<コード>` | Life OS アカウントと連携（連携前に使える唯一のコマンド） |
| `/reset` | Discord の会話履歴（`chat_messages` channel=`discord`）を削除。チャンネル設定とは独立 |

- 連携済みユーザー（`discord_links`）以外には、連携手順を案内するだけで他の処理はしません。
- Bot / Webhook 由来のインタラクションには反応しません（会話の連鎖防止）。
- 返信は 2000 文字で切り詰めます。

## 認証済み API（設定画面・e2e 用、`/api/discord/*`）

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/status` | シークレット設定状況、Interactions URL、招待 URL、連携状態、チャンネル設定、コマンド一覧 |
| POST | `/register-commands` | グローバルコマンドの一括登録 |
| POST | `/link-code` | 連携コード発行（`{code, expires_at, command}`） |
| DELETE | `/link` | 連携解除 |
| GET | `/history` | Discord 会話の直近 50 件 |
| POST | `/reset` | 会話履歴のリセット |
| POST | `/simulate` `{text}` | Discord を介さずに `/chat` と同じハンドラを実行（設定画面の「BOTを試す」、e2e） |

## ファイル

- `worker/modules/discord/routes.ts` — Interactions エンドポイント（署名検証・コマンド分岐・deferred 応答）、認証済み API
- `worker/modules/discord/service.ts` — `handleMessage`（会話ハンドラ）、連携コード、チャンネル設定、Discord REST
- `worker/modules/discord/logic.ts` — 純粋ロジック（ペイロード解析、画面リンク解決、BOT 判定、コマンド定義）
- `src/modules/discord/SettingsCard.tsx` — 設定画面に埋め込む「Discord BOT」カード
- `tests/unit/discord.test.ts`, `e2e/discord.spec.ts`

## 動作確認

- ローカルで署名なしに `POST /api/integrations/discord/interactions` → 401。
- Discord 側の署名検証を手元で試す場合は、`DISCORD_PUBLIC_KEY` に自分で生成した Ed25519 鍵の公開鍵を設定し、
  対応する秘密鍵で `timestamp + body` に署名して `X-Signature-Ed25519` / `X-Signature-Timestamp` を付けます。
- ローカルでは Workers AI バインディングがないため、`/chat` の応答は「AI未接続」のフォールバック文になります（本番では Workers AI）。
