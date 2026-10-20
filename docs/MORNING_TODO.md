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
7. 独自ドメイン `dashboard.nami-tool.com` を使う場合: Cloudflare ダッシュボード → Workers → life-os → Settings → Domains & Routes で追加

## 2. Google ログイン（必須・未完了。これだけでログインできるようになります）
1. Google Cloud Console → APIs & Services → Credentials → OAuth client ID（Web）
2. 承認済みリダイレクト URI: `https://life-os-production.namikyuu831.workers.dev/api/auth/google/callback`（ローカル検証用に `http://localhost:5173/api/auth/google/callback` も）
3. `npx wrangler secret put GOOGLE_CLIENT_ID --env production` / `GOOGLE_CLIENT_SECRET`（値はターミナルで貼り付け）
4. ローカルで使う場合は `.dev.vars` にも同じ値を書く
5. 許可するメールは `wrangler.jsonc` の `ALLOWED_EMAILS`（現在 namikyuu831@gmail.com）

## 3. 任意の連携（使うものだけ）
- **Web Push**: `npx web-push generate-vapid-keys` → `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`(mailto:) を secret に。設定 → 通知 → 「この端末の通知をON」
- **Oura**: Oura Cloud の Personal Access Token → `OURA_ACCESS_TOKEN`
- **Google カレンダー / Gmail**: OAuth クライアントに Calendar / Gmail readonly スコープを追加し、設定 → 接続 から認可（実装は読み取り専用）
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
