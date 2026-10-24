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
| `IMGGEN_TUNNEL_KEY` | 任意。自宅Mac用セットアップ（下記）に入れるトンネル用秘密鍵の**ファイルパス**（VPS 上。`~/` 可） |
| `IMGGEN_TUNNEL_HOST` | 任意。トンネルの接続先（既定 `rocky@133.167.105.210`） |

### 自宅のMacで生成する（ワンクリックセットアップ）

画像生成ページの「自宅のMacで生成する」から `lifeos-imggen-setup.zip`（`GET /api/images/home-installer`）をダウンロードし、生成に使う Mac で `LifeOS-画像生成-セットアップ.command` をダブルクリックします。中身は `imggen-home/`（サービス・generate.py・safety.py の複製、セットアップ／状態確認／アンインストール）に、`IMGGEN_TOKEN`・`IMGGEN_TUNNEL_HOST`・`IMGGEN_TUNNEL_KEY` の鍵を `secrets/`（0600）として足したものです。`IMGGEN_TOKEN` か `IMGGEN_TUNNEL_KEY` が無いと 503。

- 入る場所は `~/LifeOS-imggen`（Python は uv で中に入れる・Homebrew 不要、ComfyUI は固定コミット、モデルは内蔵ディスク）。launchd は `com.lifeos.imggen-svc` / `com.lifeos.imggen-tunnel` / `com.lifeos.imggen-awake`（`caffeinate -s -i`）。
- トンネルは接続のたびに先に `ssh … cleanup`（VPS 側の forced command）を実行して 18787 の古い待ち受けを外します。トンネルを張る Mac は 1 台だけにしてください（2 台あると交互に切断し合います）。

- 生成が終わった画像はすぐにサーバーへコピーするので、Mac が寝ていても過去の画像は表示・ダウンロードできます。画像は SQLite ではなくファイルで保存します（毎日の DB バックアップを肥大させないため）。`data/images/` は DB バックアップに含まれません。
- ページを閉じても、10 分ごとの cron が生成待ちのジョブを確認して画像を受け取ります（Mac 側はジョブを 1 時間で忘れるため）。
- 安全ガード（§0）は Life OS 側（キーワード＋AI 判定）と Mac 側（422）の二重です。

### モデル（アニメ / 実写）

画像生成ページで「アニメ」「実写」を選べます（ブラウザに記憶。履歴にもどちらで作ったかを表示、`image_generations.model`）。

| | アニメ（既定） | 実写 |
| --- | --- | --- |
| モデル | Animagine XL 4.0（`cagliostrolab/animagine-xl-4.0`） | RealVisXL V5.0 fp16（`SG161222/RealVisXL_V5.0` @ `ac93e0dd`, 6,938,065,488 B, sha256 `6a35a785…3b80`） |
| ライセンス | openrail++（商用可） | openrail++（商用可・利用制限条項あり） |
| AI 変換 | 英語 danbooru タグ | 英語の描写フレーズ（タグ・品質語なし） |
| 設定 | euler_ancestral / normal, 28 steps, CFG 5 | dpmpp_sde / karras, 30 steps, CFG 5 |
| 区分 | 全年齢・R18 | 全年齢・R18（R18 は区分で明示的に選んだときだけ・**大人だけ**） |

- 実写はディープフェイクの危険が大きいので、実在の人物（芸能人・政治家・知人・「〜に似た」「そっくり」「looks like」「deepfake」など）の指定はどの区分でもキーワードと AI 判定の両方で弾きます（Life OS とサービスの両方で 422）。
- 実写の全年齢: 性的・成人向けの語は弾き（R18 を選ぶよう案内）、NSFW 回避と未成年回避のネガティブを常に付けます。
- 実写の R18: 区分で「R18」を選んだときだけ（AI や文章からは推定しない。モデルを切り替えると全年齢に戻る）。年齢・学生・学校・制服・幼さを示す語（少女・女子高生・JK・学生・制服・ロリ・幼い・若く見える・小柄・teen・schoolgirl・petite など）と 20 歳未満の年齢（「17歳」「16 years old」）は 422。`girl`/`boy`/`1girl` は弾かずに `woman`/`man` に書き換え、AI 変換も woman/man で書きます。Mac 側（generate.py）は大人の年齢のポジティブ（`adult woman, mature adult, 25 years old, adult body proportions` など。性別は依頼のまま）を先頭に、強めの未成年回避ネガティブを常に付けます（NSFW 回避は外す）。語の一覧は `worker/modules/images/logic.ts` の `PHOTO_R18_YOUTH_TERMS` と `imggen-home/app/safety.py` の同名リスト（同じ内容）。
- 古いサービス（この方針より前のセットアップ）は実写 R18 を 422 で断るので、自宅Macでセットアップをもう一度実行して更新します。
- サービス API: `POST /v1/generate` の `"model": "anime" | "photo"`（省略時は anime）、`GET /v1/health` の `"models": {"anime": bool, "photo": bool}`。`models` の無い古いサービスは実写を使えない扱い（`model` を無視してアニメで描いてしまうため、Life OS が送る前に確認します）。
- 実写モデルは任意です。自宅Macの空きが足りないとセットアップは実写を省略し（アニメだけで動く）、空きを作って再実行すると追加します。

### 自宅Macの更新

新しい zip をダウンロードして `LifeOS-画像生成-セットアップ.command` をもう一度実行するのが更新です。スクリプトを入れ替え、確認済みのモデル（`.verified`）はダウンロードし直さず、常駐（launchd）を登録し直します。

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
