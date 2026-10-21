# Life OS FX hub

FX の高頻度な処理（Windows コネクターの 5 秒ごとの接続報告・価格・ローソク足・許可の取得）を、Cloudflare の無料枠ではなく自前の VPS で処理する常駐プログラムです。中身は Worker の FX モジュール（`worker/modules/fx/`）そのもので、D1 の代わりに SQLite（`node:sqlite`）を使います。

```
Windows コネクター ──▶ Life OS Worker (/api/integrations/fx/*) ──転送──▶ FX ハブ
Life OS 画面        ──▶ Life OS Worker (/api/fx/*)              ──転送──▶ FX ハブ
FX ハブ ──約定通知（アウトボックス・再送あり）──▶ Worker /api/integrations/fxhub/notify
```

Worker は `FX_HUB_URL` と `FX_HUB_SECRET`（Cloudflare secret）があるときだけ転送します。無ければ従来どおり D1 で処理します。

## 配置（VPS）

| 項目 | 値 |
| --- | --- |
| サーバー | `rocky@133.167.105.210`（さくら VPS、Rocky Linux 10、Node 24） |
| フォルダー | `~/lifeos-fx-hub`（`dist/`・`migrations/`・`data/fx-hub.sqlite`・`hub.env`） |
| 常駐 | PM2 `lifeos-fx-hub`（`127.0.0.1:8790`）。`pm2 save` 済みで再起動後も自動起動 |
| 公開 | nginx `/etc/nginx/conf.d/lifeos-fx-hub.conf` → `https://fx.133.167.105.210.nip.io`（certbot で自動更新） |
| 秘密情報 | `~/lifeos-fx-hub/hub.env`（権限 600。`hub.env.example` 参照）。リポジトリには入れない |

## 更新

```bash
bash hub/deploy.sh
```

ビルドして転送し、`lifeos-fx-hub` だけを再起動します。`hub.env` と `data/` は残ります。同じ VPS の `kintore-bot`・`life-dashboard`・`luna-*`・`okurijo-csv` には触れません。

## 確認・トラブル時

```bash
ssh rocky@133.167.105.210 'source ~/.nvm/nvm.sh; pm2 logs lifeos-fx-hub --lines 50 --nostream'
curl https://fx.133.167.105.210.nip.io/health
```

- 一部のネットワーク（FortiGate などの SSL 検査）では `*.nip.io` に繋がりません。コネクターは既定で Worker 宛てに送るので影響しません。Windows から直接ハブへ送りたいときは、Worker の secret `FX_HUB_PUBLIC_URL` に `https://fx.133.167.105.210.nip.io` を設定してから zip を取り直します。
- バックアップは `data/fx-hub.sqlite`（WAL モード）。止めずに取るなら `sqlite3 data/fx-hub.sqlite ".backup backup.sqlite"`。
