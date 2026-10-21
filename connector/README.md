# Life OS FXコネクター（Windows / MT5） 1.0.0

Windows PC の MT5（XM）と Life OS サーバーをつなぐコネクターです。
**判断・注文・追加・SL/TP・トレーリング・時間決済・照合はすべてこのPC（コネクター）が行います。**
Life OS サーバーは許可・設定・状態・履歴・通知を持つだけで、注文は一切出しません。

## どこで何が動くか

| 場所 | 役割 |
| --- | --- |
| Windows（このフォルダー） | 3ルール（ルールA改良版・ドンチャン改良4・ドンチャン改良6）の確定足判定、発注、Aの追加（最大3回）、SL/TP、トレーリング、時間決済、台帳（`state/*.json`）とMT5の照合 |
| Life OS サーバー | 許可（どのルールが新規を出してよいか・共通lot・改良6の想定損失・取引時間・R停止）、30秒リース、受信した状態・判定・約定・ローソク足・価格の保存と通知 |

ファイル構成:

| ファイル | 内容 |
| --- | --- |
| `lifeos_connector.py` | 入口（`--check` / `--once` / 常駐 / `--clear-stop`） |
| `lifeos_agent.py` | サーバー許可・報告（heartbeat・signals・trades・candles・quotes）と3ルールの実行管理 |
| `mt5_adapter.py` | MetaTrader5 への接続、口座の固定、銘柄名の対応付け（`USDJPY#` などの接尾辞も可） |
| `rule_a_engine.py` `donchian_engine.py` `donchian_v6_engine.py` `mt5_time.py` | 旧コネクターのルールエンジン（無変更） |
| `rule_a_agent.py` `donchian_agent.py` `donchian_v6_agent.py` `auto_strategies.py` | 旧コネクターの注文・保護・照合ロジック（報告用の項目追加のみ） |

magic 番号は旧コネクターと同じです（A 26061801 / 改良4 26101804 / 改良6 26101906）。

## 安全ルール

1. **新規・追加は全部そろったときだけ**: サーバーでそのルールが有効、リースをこの端末が保持、許可が新しい（最大30秒。通信できず失効したら停止）、日−2R／週−3R／月−2R（3ルール合算・UTC区切り。サーバーと自分の台帳のどちらかが止めれば停止）、取引時間内、年度設定が有効（改良4・6は 2027-10-01 から新規停止）、サーバー時計とのずれ5秒以内。発注直前にも許可を取り直します。
2. **既存の管理ポジションは新規停止中も保護・決済を続けます**（SL/TP、トレーリング、時間決済）。
3. 判断は**確定足だけ**。確定後**30秒以内**に最初に取れた実勢Ask/Bidで実行し、遅れた条件は追いません。
4. **結果が分からない注文は再送しません**。そのルール（と他ルールの新規）を止め、MT5の保有・約定履歴と照合します。報告の再送で注文が出ることはありません。
5. 自分の台帳（magic＋台帳）にあるポジションだけを管理します。手動・他システムのポジションは引き継がず、触りません（口座に未照合のポジションがある間は新規を出しません）。
6. 台帳 `state/rule-a.json` `state/donchian.json` `state/donchian-v6.json` は原子的に書き込みます。**台帳を削除して停止理由を消さないでください**（リスク集計と所有ポジションが失われ、安全確認待ちになります）。
7. 何もしなければ**全ルール無効**です（サーバーで有効にしたルールだけ新規を出します）。`--check` と `--once` は注文を出しません。
8. 数量: A・改良4はサーバーの共通lot（Aの追加は開始時のlotを維持）。改良6は予定SL損失＋費用が60 USD以内になる数量へ切り下げ、最小lotでも超えるなら発注しません（サーバー側の想定損失を60より小さくすると、その値を使います）。
9. 同じフォルダーで2つ起動することはできません（`state/connector.lock`）。

## インストール

1. Python 3.11 以上と MT5（XM）を入れ、MT5にログインし、「アルゴ取引」を有効にします。
2. Life OS の「FXシグナル → 設定・接続 → かんたん更新・インストール」で zip をダウンロードし、任意のフォルダーに展開します（`lifeos_connector.ini` に接続先とトークンが入っています）。
3. `install.bat` → `check.bat`。`check.bat` は接続確認だけで注文は出しません。表示の `time_basis_hint` が `TIME_BASIS` と違うときは下の `lifeos_connector.local.ini` で直します。
4. `run.bat` で常駐させます（1秒ごとに処理、5秒ごとに許可を同期し30秒リースを更新）。

自分用の設定は `lifeos_connector.local.ini` に書きます（zip に含まれないので更新で消えません）:

```
[lifeos]
MT5_LOGIN=12345678        ; 推奨: この口座以外では動かない（空なら起動時にログイン中の口座へ固定）
MT5_SERVER=XMTrading-MT5 3
TIME_BASIS=xm_europe      ; MT5の時刻が UTC なら utc
SYMBOL_MAP=               ; 銘柄の候補が複数あるとき: USD_JPY:USDJPY#,EUR_JPY:EURJPY#
```

### 旧コネクターからの切り替え

1. **旧コネクターを先に止めます**（両方動くと同じ口座を二重に管理します）。
2. 旧コネクターに保有が残っているときは、旧フォルダーの `state/rule-a.json` `state/donchian.json` `state/donchian-v6.json` をこのフォルダーの `state/` にコピーします（形式は同じです）。コピーしないと、今月・今週に旧コネクターの約定があるルールは安全のため停止します。

## ルールを有効にする

Life OS の「FXシグナル → 設定・接続」で、ルールA改良版・ドンチャン改良4・ドンチャン改良6 を個別にONにします。共通lot、改良6の想定損失、取引時間、R停止もここで設定します。OFFにすると新規・追加だけが止まり、保有中のポジションの保護と決済は続きます。

## 停止理由と解除

停止理由は Life OS の「設定・接続」に表示されます。照合できない注文などで止まったルールは自動では再開しません。MT5の保有・履歴を確認したうえで、`run.bat` を閉じてから:

```
py -3 lifeos_connector.py --clear-stop rule_a      (donchian4 / donchian6)
```

結果未確認の注文が残っている、MT5の保有と台帳が一致しない、などの場合は解除を拒否します。台帳は削除されません。

## 更新

「かんたん更新・インストール」で新しい zip を取得し、`run.bat` を閉じてから**同じフォルダーに上書き展開**します。`lifeos_connector.local.ini` と `state/` は残ります（`lifeos_connector.ini` は新しい接続設定で置き換わります）。その後 `check.bat` → `run.bat`。

## 実行オプション

```
py -3 lifeos_connector.py --check   # 接続確認のみ（注文なし）
py -3 lifeos_connector.py --once    # 1回だけ同期: 価格・ローソク足・判定を送る（注文なし・台帳も書かない）
py -3 lifeos_connector.py           # 常駐
```

## サーバーAPI（`/api/integrations/fx/*`、`Authorization: Bearer <FX_CONNECTOR_TOKEN>`）

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/heartbeat` | 端末状態（口座・残高・管理中ポジション・MT5接続・停止理由・version）＋リース更新。応答に permissions |
| GET | `/permissions?terminal_id=` | 許可（発注直前に取り直す） |
| POST | `/signals` | 確定足の判定 `stage: none / setup / entry` |
| POST | `/trades` | 約定 `open / add / close / modify`（ticket＋event で冪等） |
| POST | `/candles` | 確定足 M5（30日）・H1（日足SMA90用の長い履歴）・H4（H1から作るUTC 4時間足）・D1（ブローカー日足） |
| POST | `/quotes` | 実勢 Bid/Ask（5秒ごと） |

口座番号・接続トークンをチャットやメールへ貼り付けないでください。
