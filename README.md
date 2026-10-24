# Life OS

予定・健康・トレーニング・お金・FX・通知を一つの画面で管理する個人向けアプリ。通知は Mac・Android などへの Web Push で届きます。
仕様は [docs/SPEC.md](docs/SPEC.md)、モジュール実装の約束事は [docs/CONVENTIONS.md](docs/CONVENTIONS.md)。

## 構成

```
life-os/
├─ worker/            Cloudflare Worker（API・cron・連携）
│  ├─ index.ts        Hono アプリ。/api/* をルーティング、scheduled() で cron
│  ├─ core/           OS 部分: auth / db / ai / context / notify / weather / routes
│  └─ modules/<name>/ 各モジュールの API（routes.ts）と純粋ロジック（logic.ts）
├─ src/               React フロントエンド（Vite）
│  ├─ app/            Shell（サイドバー・通知ベル・テーマ）/ 認証 / ルーター
│  ├─ components/ui/  共通 UI キット（Apple HIG 風、デザイントークン駆動）
│  ├─ styles/app.css  デザイントークン（文字サイズ・余白・角丸を一括調整）
│  └─ modules/<name>/ 各モジュールの画面
├─ shared/            Worker と画面で共有する型・定数
├─ migrations/        D1（SQLite）マイグレーション
├─ connector/         Windows MT5 コネクターの骨組み（Python）
├─ tests/unit/        Vitest（純粋ロジック）
└─ e2e/               Playwright（実ブラウザ操作テスト）
```

### 動いている場所（2026-10-21〜）

本番は **旧 VPS 上の自前サーバー**（`https://dashboard.nami-tool.com`）です。Cloudflare Worker 用に書いたアプリを、D1→SQLite、KV→SQLite、Cron→プロセス内タイマーに差し替えて Node.js で動かしています（[server/README.md](server/README.md)）。Cloudflare には Workers AI の中継と、旧 `workers.dev` アドレスの転送だけが残っています。理由は、FX のコネクター通信（5 秒ごと）が Cloudflare 無料枠の書き込み上限を超えたためです。

### OS 部分と共有データ

- **Life Context** (`worker/core/context.ts`): 睡眠・回復・歩数、筋トレ、予定・タスク、カード・現金、FX、メモを 1 つのスナップショットにまとめます。すべての AI 相談（健康・食事・美容・FP・Discord）はこのスナップショットを前提に回答するため、生活全体を踏まえた提案になります。欠測・古い値は null / フラグとして渡し、推測で埋めません。
- **通知** (`worker/core/notify.ts`, `worker/core/push.ts`): アプリ内ベル（常にすべて記録）と端末プッシュ。プッシュはモジュール単位の ON/OFF（必要なら種類ごと、`shared/notifications.ts`）、端末ごとの登録、永続キュー、再試行、期限、重複防止（FX 約定は長期限・多回数）。届かなくなった端末（404/410）は自動で削除。
- **設定** (`settings` テーブル): 地域、通知、予算、FX 設定などを JSON で保持。

## 技術選定と理由

| 領域 | 選定 | 理由 |
| --- | --- | --- |
| 実行基盤 | **Cloudflare Workers**（静的アセット同梱） | 指示どおり Cloudflare 基本。フロント配信と API を 1 つの Worker で配信でき、常駐サーバーも PM2 も不要。cron trigger で Oura 同期・通知配信を定期実行 |
| API | **Hono** | Workers 向けに最軽量・型安全。ミドルウェアでセッション認証と同一サイト確認を一括適用 |
| DB | **D1 (SQLite)** | 旧版が SQLite だったためスキーマ移行が素直。個人利用の規模に十分、マイグレーション管理が wrangler で完結 |
| セッション・キャッシュ | **KV** | セッション、OAuth state、天気キャッシュ、FX 実行リースなど TTL 付きデータに最適 |
| AI | **Workers AI**（Llama 3.3 70B） | 指示どおり。外部 API キー不要で Cloudflare 内で完結。ローカル開発や未接続時は決定的フォールバックで UI とテストが止まらない |
| 認証 | **Google OAuth 2.0 のみ**（自前実装） | 指示どおり Google 認証のみ。許可メール一覧（`ALLOWED_EMAILS`）で本人限定。ライブラリ不要の最小実装で依存を減らす。開発時のみ `DEV_LOGIN=1` で開発用ログイン |
| フロント | **React 19 + Vite + TypeScript** | `@cloudflare/vite-plugin` で Worker とフロントを同じ dev サーバーで動かせる。モジュール単位の遅延読み込みで初期表示を軽く |
| ルーティング | react-router v7 | 14 モジュールを `/<module>/*` に分割、各モジュール内でサブルート可 |
| スタイル | **Tailwind CSS v4 + CSS 変数トークン** | `--ui-font-scale` / `--ui-space-scale` / `--ui-radius-scale` から全サイズを派生。設定画面のスライダーで文字サイズ・余白・角丸を一括調整。Apple HIG のセマンティックカラーを light/dark で定義 |
| アニメーション | **motion**（Framer Motion の後継） | レイアウトアニメーション（サイドバー、セグメント）、入場スタッガー、モーダル、トーストを宣言的に。`prefers-reduced-motion` と設定で抑制可 |
| チャート | recharts（推移）・lightweight-charts（FX ローソク足） | 資産・カード推移は recharts で十分。FX はローソク足・マーカー・欠損詰めが必要なので TradingView 製の lightweight-charts |
| 通知 | **Web Push（VAPID、`@block65/webcrypto-web-push`）** | WebCrypto だけで aes128gcm 暗号化（RFC 8291）と VAPID 署名を行うため、Node（自前サーバー）でも Workers でも同じに動く。Service Worker は通知専用で認証済みデータをキャッシュしない |
| Discord | **停止中**（2026-10-24〜） | `DISCORD_ENABLED=1` のときだけ Interactions エンドポイントと `/api/discord/*` が動く。未設定なら 404 |
| バリデーション | zod v4 | API 入力を全て検証 |
| テスト | **Vitest**（純粋ロジック）+ **Playwright**（実ブラウザ） | 1RM、気圧判定、カード目安、FX 計算などは単体で固定。画面はデスクトップ/モバイル両方で実際に操作 |
| 天気 | Open-Meteo | 旧版と同じ。無料・鍵不要・海面気圧の時系列が取れる |

### 旧版（Python/FastAPI + SQLite + PM2）からの変更点

- 常駐プロセスを廃止し、Workers の cron とキューで代替（Oura 10 分、freee 1 時間、朝 07:00 JST、通知配信）。
- Discord の Gateway BOT はメンション反応ができないため、スラッシュコマンド `/chat` に置き換え（詳細 [docs/discord.md](docs/discord.md)）。
- FX の注文実行は引き続き Windows MT5 コネクター側。サーバーは許可・設定・履歴・通知・チャートを担当（[connector/README.md](connector/README.md)）。

## アプリ全体の機能

- **コマンドパレット** ⌘K / Ctrl+K: モジュール移動、「タスクを追加: …」「アイデアを保存: …」「メモ: …」「今しんどい」、テーマ切替
- **モバイル**: 下部タブバー（標準はダッシュボード・スケジュール・健康・トレーニング・カード。設定 → 表示 → 下のバーで3〜5個を選んで並び替え、ユーザーごとにサーバー保存）＋「その他」と左端スワイプのドロワー
- **デザイン切替**: 設定 → 表示で「スタンダード / グラス / マテリアル」× ライト・ダーク。トークン（CSS変数）を `html[data-design][data-theme]` で切り替え、アイコンは自作の線画（`src/components/icons.tsx`）
- **設定 → 接続**: Google（カレンダー・Gmail）と Oura を画面から接続（トークンは AES-GCM で暗号化保存）
- **設定 → データ**: 全データの JSON 書き出し・読み込み（追加 / 置き換え）、メモの Markdown 書き出し（Obsidian 向け）
- **エラー境界**: 1 画面の例外がアプリ全体を止めない。デプロイ後のチャンク更新は再読み込みを案内
- **チャット**: 食事・健康・美容・FP相談・アシスタントで共通。入力欄は Enter で改行、⌘/Ctrl＋Enter で送信。高さは固定で、履歴はその中だけをスクロール
- **食事の記録**: その日に食べたものを記録する形。「ゆで卵 2個」と入れて Enter ですぐ記録（栄養は裏側で成分表から計算）、セットは丸ごと、「よく食べるもの」は1タップで追加できる。行をタップすると、成分表の食品・グラム数・回数・費用・手入力の値を1枚のシートで直せる。日付と直近7日を切り替えて過去も見返せる
- **栄養の自動入力（日本食品標準成分表）**: 食べたものと量を入れると、文部科学省「日本食品標準成分表（八訂）増補2023年」の2,538食品から近い食品を選び、可食部のグラム数に合わせて20項目の栄養を計算する。AIは成分表の食品から1つを選ぶことと「2個」「1本」をグラムに直すことだけを担当し、栄養の数値は成分表の値だけを使う。未測定の値は0ではなく不明のまま扱う。サプリや市販品は成分表に無いため、表示値の手入力を案内する
- **食事チャットからの反映**: 会話で頼んだ記録の追加・変更・削除や目標値の変更が、返答の下にカードで出る。内容を確認し、チェックを外して選びながら反映（量だけ変えた場合は栄養を換算して推定値として保存）
- **総合アシスタント** ⌘J / Ctrl+J: どの画面からも開くスライドパネル。Life Context 全体を前提に相談し、返答から「タスクにする / リマインド / メモ」をワンタップで登録（提案抽出は本番の Workers AI でのみ）
- **画像生成**: 日本語の文章を AI が英語タグに変換し、Mac の画像生成サービス（SSH トンネル経由）で生成。できた画像はサーバーに保存するので Mac が寝ていても見返せる。未成年の性的表現・実在人物・既存キャラクター・作家名は Life OS 側と Mac 側の両方で拒否。設定は [server/README.md](server/README.md#画像生成mac-連携)
- **ダッシュボードの編集**: カードの並び替え・非表示を保存
- **一言アドバイス**: ルールベースの提案を Workers AI が生活データ全体を踏まえて言い換え（1 時間キャッシュ）

## ローカル開発

```bash
npm install
cp .dev.vars.example .dev.vars   # SESSION_SECRET を適当な長い文字列に
npm run db:migrate:local
npm run dev                      # http://localhost:5173（開発用ログインが使える）
```

テスト:

```bash
npm test             # Vitest
npm run test:e2e     # Playwright（dev サーバーを自動起動）
```

## デプロイ

本番（自前サーバー）は `npm run deploy`。以下は Cloudflare だけで動かす旧構成の手順です。

### Cloudflare だけで動かす場合

```bash
npx wrangler login
npx wrangler d1 create life-os-db          # → database_id を wrangler.jsonc の env.production に
npx wrangler kv namespace create KV        # → id を wrangler.jsonc の env.production に
npm run db:migrate:remote
npx wrangler secret put SESSION_SECRET --env production
npx wrangler secret put GOOGLE_CLIENT_ID --env production
npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
# 任意: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT, OURA_ACCESS_TOKEN, FREEE_*, BACKUP_INGEST_TOKEN, FX_CONNECTOR_TOKEN
npm run deploy
```

Google OAuth のリダイレクト URI は `https://<your-domain>/api/auth/google/callback`。`APP_ORIGIN`（wrangler.jsonc の env.production.vars）を本番 URL に合わせてください。

VAPID 鍵の生成: `npx web-push generate-vapid-keys`（または `node -e` で WebCrypto から生成）。

## セキュリティ方針

- 認証情報はすべて Cloudflare Secrets。リポジトリ・画面・通知・ログに載せない。
- 更新系 API は `Origin` / `Sec-Fetch-Site` で同一サイトを確認。
- freee トークンは AES-GCM で暗号化して保存。
- Service Worker は通知のみ。認証済みデータをキャッシュしない。

## データの出典

食品の栄養値は、文部科学省「日本食品標準成分表（八訂）増補2023年」（https://www.mext.go.jp/a_menu/syokuhinseibun/mext_00001.html）を加工して作成しています（`worker/modules/health/food-table.json`、変換は `scripts/build-food-table.py`）。同データは政府標準利用規約（第2.0版）に従って利用しています。
