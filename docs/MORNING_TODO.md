# 朝にやること（本人の確認・操作が必要な項目）

ローカルでは全モジュールが動き、テストも通る状態です。本番公開と外部連携は以下の操作が必要です。

## 1. Cloudflare — 完了（2026-10-21 深夜）

D1 `life-os-db`、KV、SESSION_SECRET、VAPID 鍵、BACKUP_INGEST_TOKEN、FX_CONNECTOR_TOKEN を設定し、本番にデプロイ済み。

本番 URL: https://life-os-production.namikyuu831.workers.dev

以前の手順（参考）:
1. `npx wrangler login`（ブラウザで認証。トークン切れのため再ログインが必要）
2. `npx wrangler d1 create life-os-db` → 出力の `database_id` を `wrangler.jsonc` の `env.production.d1_databases[0].database_id` に貼る
3. `npx wrangler kv namespace create KV` → `id` を `env.production.kv_namespaces[0].id` に貼る
4. `npm run db:migrate:remote`
5. `npx wrangler secret put SESSION_SECRET --env production`（長いランダム文字列）
6. `npm run deploy` → 表示される `https://life-os.<account>.workers.dev` を `env.production.vars.APP_ORIGIN` に設定して再度 `npm run deploy`
7. 独自ドメイン `dashboard.nami-tool.com`: **nami-tool.com はこの Cloudflare アカウントのゾーンにありません**（ast-luna.com のみ）。方法は2つ。(a) nami-tool.com のネームサーバーを Cloudflare に移してから Workers → life-os-production → Settings → Domains & Routes でカスタムドメイン追加、(b) 現在の DNS 管理先で `dashboard` を `life-os-production.namikyuu831.workers.dev` へ CNAME（この場合 TLS は workers.dev 側のため Cloudflare 経由でないと証明書エラーになる可能性あり。(a) 推奨）。設定後 `wrangler.jsonc` の `env.production.vars.APP_ORIGIN` と Google のリダイレクト URI をそのドメインに変更して `npm run deploy`

## 2. Google ログイン（必須・未完了。これだけでログインできるようになります）
1. Google Cloud Console → APIs & Services → Credentials → OAuth client ID（Web）
2. 承認済みリダイレクト URI: `https://life-os-production.namikyuu831.workers.dev/api/auth/google/callback`（ローカル検証用に `http://localhost:5173/api/auth/google/callback` も）
3. `npx wrangler secret put GOOGLE_CLIENT_ID --env production` / `GOOGLE_CLIENT_SECRET`（値はターミナルで貼り付け）
4. ローカルで使う場合は `.dev.vars` にも同じ値を書く
5. 許可するメールは `wrangler.jsonc` の `ALLOWED_EMAILS`（現在 namikyuu831@gmail.com）

## 3. 任意の連携（使うものだけ）
- **Web Push**: `npx web-push generate-vapid-keys` → `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`(mailto:) を secret に。設定 → 通知 → 「この端末の通知をON」
- **Oura**: Oura Cloud（cloud.ouraring.com → Personal Access Tokens）でトークンを発行 → アプリの **設定 → 接続 → Oura** に貼り付けて「接続」（Oura API で検証してから暗号化保存。10分ごとに自動同期、「今すぐ同期」も可）。シークレット `OURA_ACCESS_TOKEN` は不要になりました（設定してあればそちらが優先されます）
- **Google カレンダー / Gmail**: 上の「2. Google ログイン」と同じ OAuth クライアントを使います。追加で必要な操作:
  1. Google Cloud Console → APIs & Services → Library で **Google Calendar API** と **Gmail API** を有効化
  2. 同じ OAuth クライアントの承認済みリダイレクト URI に `https://life-os-production.namikyuu831.workers.dev/api/integrations/google/callback` を追加（ローカル検証用に `http://localhost:5173/api/integrations/google/callback` も）
  3. OAuth 同意画面のスコープに `.../auth/calendar.readonly` と `.../auth/gmail.readonly` を追加（テストユーザーに自分のメールを登録）
  4. アプリの **設定 → 接続 → Google** で「カレンダー」「Gmail」にチェックして「接続する」→ Google で許可（読み取り専用。トークンは暗号化保存、解除はいつでも同じ画面から）
- **freee**: freee アプリストアでアプリ作成（コールバック `https://<本番>/api/assets/freee/callback`）→ `FREEE_CLIENT_ID` / `FREEE_CLIENT_SECRET`
- **Discord**: docs/discord.md の手順。`DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` / `DISCORD_BOT_TOKEN`。Interactions Endpoint URL を `https://<本番>/api/integrations/discord/interactions` に
- **バックアップPC**: `BACKUP_INGEST_TOKEN` を secret に設定し、PC 側の送信部に同じ値
- **FX コネクター**: `FX_CONNECTOR_TOKEN` を secret に設定し、`connector/` の Python を Windows に配置（MT5 実装は TODO）

## 4. GitHub
- リポジトリは public で作成済み: https://github.com/namityantyan/life-os秘密情報は含まれていません（`.dev.vars` は gitignore）。

## 5. 確認してほしい設計判断
- Discord は Workers の制約で「メンション反応」ではなく `/chat` スラッシュコマンド方式（docs/discord.md）
- FX の自動売買本体は従来どおり Windows 側。サーバーは許可・履歴・通知・チャートのみ
- AI は Workers AI（Llama 3.3 70B）。Claude API を併用したい場合は `worker/core/ai.ts` に追加可能

## 6. ローカルで触る

```bash
cd /Users/nami/Claude/Projects/life-os
npm run dev
```

http://localhost:5173 を開き「開発用ログイン」を押す（Google未設定でも入れます）。テストは `npm test` と `npm run test:e2e`。

## 7. 夜間に追加・改善したもの（確認用）

- 設定 → 接続: Google（カレンダー・Gmail）/ Oura の接続フロー（Google はクライアント設定後に使えます）
- ⌘K コマンドパレット（移動・クイック追加・テーマ）
- スマホ下部タブバー、エラー境界、デプロイ後の再読み込み案内
- 設定 → データ: JSON 書き出し/読み込み、メモの Markdown 書き出し
- ダッシュボードの一言を Workers AI が生活データ全体から言い換え（本番のみ。1時間キャッシュ）
- ⌘J 総合アシスタント（全画面から相談、返答をタスク/リマインド/メモに登録）
- ダッシュボードのカード並び替え・非表示（右上「編集」）
- 全画面のデザイン・アクセシビリティ統一（表の数値右寄せ、ダークモードのチャート色、スマホの横スクロール解消、ボタンのラベル、読込失敗時の再読み込み）。比較画像: docs/screenshots/
- GitHub Actions CI（型チェック・単体・ブラウザテスト）。`CLOUDFLARE_API_TOKEN` をリポジトリ secret に入れると main への push で自動デプロイ
- レビューで修正した不具合: 口座の部分更新で名義・通貨が初期化される、カード CSV 明細と利用通知の二重計上、追加利用の目安が常に保留になる、トレーニングの単位をクライアントが偽装できる、バックアップ再送が 409、Discord の会話チャンネルを他人が上書きできる、検索の `%`/`_` ワイルドカード、読込失敗時に空表示になる画面、など
