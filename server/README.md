# Life OS（自前サーバー版）

2026-10-21 から、Life OS は旧 VPS で動いています。中身は Cloudflare Worker 用のアプリ（`worker/`）そのもので、Cloudflare の機能を Node.js 上の代替に差し替えて動かしています。

| Cloudflare の機能 | 自前サーバーでの代替 |
| --- | --- |
| D1 | SQLite（`node:sqlite`、`data/lifeos.sqlite`、WAL） |
| KV | SQLite の `_kv` テーブル（有効期限つき） |
| Workers AI | Cloudflare の中継 Worker 経由（`/api/internal/ai`、無料枠のまま） |
| 静的配信 | `client/`（`vite build` の成果物、SPA フォールバック） |
| Cron Triggers | プロセス内で毎分判定（`*/10 * * * *`・`0 * * * *`・`0 22 * * *`、UTC） |

```
ブラウザ / PWA ─▶ https://dashboard.nami-tool.com ─▶ nginx ─▶ 127.0.0.1:8791（PM2 lifeos）
Windows コネクター・バックアップ PC ─▶ workers.dev（中継）─▶ dashboard.nami-tool.com
Google ログイン ─▶ workers.dev の callback（Google に登録済み）─302─▶ dashboard.nami-tool.com
```

## 配置

| 項目 | 値 |
| --- | --- |
| サーバー | `rocky@133.167.105.210`（Rocky Linux 10、Node 24、PM2） |
| フォルダー | `~/lifeos`（`dist/`・`client/`・`migrations/`・`data/`・`server.env`） |
| 常駐 | PM2 `lifeos`（`127.0.0.1:8791`）。`pm2 save` 済み |
| 公開 | nginx `/etc/nginx/conf.d/dashboard-nami.conf` の `location /`（変更前は `.bak-lifeos-20261021`） |
| 秘密情報 | `~/lifeos/server.env`（権限 600）。リポジトリには入れない |
| バックアップ | 毎日 03:30 JST に `data/backups/lifeos-YYYY-MM-DD.sqlite`（14 日分） |

旧ダッシュボード（`life-dashboard`）は `https://dash.133.167.105.210.nip.io` で引き続き見られます。旧 Discord BOT（`kintore-bot`）は停止済み。FX ハブ（`~/lifeos-fx-hub`）は統合済みで停止・PM2 から削除済み（データは残してあります）。

## 画像生成（Mac 連携）

画像生成ページ（`/images`）は、Mac 上の画像生成サービス（`ai-image-business/scripts/imggen_service.py`）を SSH リバーストンネル経由で呼びます。

```
ブラウザ ─▶ lifeos（/api/images/*）─HTTP+Bearer─▶ 127.0.0.1:18787 ─トンネル─▶ Mac:8787 imggen-svc
```

`~/lifeos/server.env` に次を足して `pm2 restart lifeos --update-env`（どちらも未設定なら画面は「未設定」になるだけで他は動きます）:

| 変数 | 内容 |
| --- | --- |
| `IMGGEN_URL` | `http://127.0.0.1:18787`（トンネルの VPS 側） |
| `IMGGEN_TOKEN` | Mac 側サービスと同じトークン。旧 BOT の `~/kintore-bot/.env` にある値と同じもの。ブラウザには渡さない |
| `IMGGEN_STORE_DIR` | 任意。生成画像の保存先（既定 `~/lifeos/data/images`） |

- 生成が終わった画像はすぐにサーバーへコピーするので、Mac が寝ていても過去の画像は表示・ダウンロードできます。画像は SQLite ではなくファイルで保存します（毎日の DB バックアップを肥大させないため）。`data/images/` は DB バックアップに含まれません。
- ページを閉じても、10 分ごとの cron が生成待ちのジョブを確認して画像を受け取ります（Mac 側はジョブを 1 時間で忘れるため）。
- 安全ガード（§0）は Life OS 側（キーワード＋AI 判定）と Mac 側（422）の二重です。

## 更新

```bash
npm run deploy          # = bash server/deploy.sh（ビルド→転送→lifeos だけ再起動）
npm run deploy:relay    # Cloudflare の中継 Worker を更新するとき
```

`npm run deploy:cloudflare-full` は旧構成（Cloudflare でアプリ全体を動かす）に戻すときだけ使います。実行すると中継が上書きされます。

## 確認・トラブル時

```bash
ssh rocky@133.167.105.210 'source ~/.nvm/nvm.sh; pm2 logs lifeos --lines 80 --nostream'
curl https://dashboard.nami-tool.com/api/health
```

- 画面は出るが AI が「AI未接続」になる → 中継 Worker（`AI_RELAY_SECRET`）か Workers AI の無料枠を確認。
- Google ログインで「invalid oauth state」→ 10 分以上かかったか、別のブラウザで開いた。もう一度ログインから。
- 元に戻す（緊急時）: `sudo cp /etc/nginx/conf.d/dashboard-nami.conf.bak-lifeos-20261021 /etc/nginx/conf.d/dashboard-nami.conf && sudo systemctl reload nginx` で旧ダッシュボードに戻ります。
