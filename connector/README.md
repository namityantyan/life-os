# Life OS FXコネクター（Windows / MT5）— 骨組み

このフォルダーは、Windows PC上のMT5（XM）とLife OSサーバーをつなぐコネクターの**骨組み**です。
実際の判断・注文・保護・時間決済はすべてこのコネクター（Windows側）が行い、
Life OSサーバーは **許可・設定・状態・履歴・通知** を保持するだけで、注文は一切出しません。

`lifeos_connector.py` は requests ベースの同期ループと、MT5アダプター／3ルールエンジンのスタブです。
MT5の実呼び出しは `TODO` として未実装です（`--check` / `--once` では注文を出しません）。

## エンドポイント（サーバー側: `/api/integrations/fx/*`）

すべて `Authorization: Bearer <FX_CONNECTOR_TOKEN>` が必要です（不一致は 401）。

| メソッド | パス | 用途 | 送る内容 |
| --- | --- | --- | --- |
| POST | `/heartbeat` | 端末状態の送信 + 30秒リースの取得・更新 | `{terminal_id, account, equity, positions[], version, mt5_connected, stop_reasons[]}` |
| GET | `/permissions?terminal_id=` | 許可・設定・リース状態（約5秒ごと） | — |
| POST | `/signals` | 確定足の判定結果（準備・条件成立・不成立） | `{pair, rule, side, stage:'none'|'setup'|'entry', bar_time, indicators}` |
| POST | `/trades` | 約定イベント（ticket+event で冪等） | `{event:'open'|'add'|'close'|'modify', ticket, rule, pair, side, price, lots, sl, tp, pnl_usd, r_multiple, at}` |
| POST | `/candles` | 確定ローソク足のバッチ（upsert、1回2000本まで） | `{pair, timeframe:'M5'|'H1'|'H4'|'D1', bars:[{t,o,h,l,c}]}`（t = UTC unix秒・足の開始） |
| POST | `/quotes` | 実勢Bid/Ask | `{pair, bid, ask, at}` |

`/heartbeat` のレスポンスには最新の `permissions` が含まれるので、通常は heartbeat だけで同期できます。

### permissions の内容

```json
{
  "enabled_rules": ["rule_a"],
  "common_lot": 0.30,
  "risk_usd_donchian6": 60,
  "trading_hours": {"start_utc": 6, "end_utc": 20, "weekdays_only": true},
  "r_limits": {"day": -2, "week": -3, "month": -2},
  "r_limit_block": {"blocked": false, "reason": null, "day_r": 0, "week_r": 0, "month_r": 0},
  "year_config_valid_until": "2027-10-01",
  "year_config_valid": true,
  "lease": {"holder": "win-home", "expires_at": "…", "held_by_you": true},
  "server_time": "…"
}
```

- `enabled_rules` に入っていないルールは **新規・追加を出さない**。既存の管理ポジションの保護（SL/TP・トレーリング・時間決済）は続ける。
- `year_config_valid` が false（2027-10-01以降）のとき、改良4・6はサーバー側で `enabled_rules` から外れる。
- `r_limit_block.blocked` が true のとき、3ルール合算の実現Rが日−2R／週−3R／月−2R（UTC区切り）に達している。新規・追加を止める。
  コネクター側でも自分の台帳から同じ計算を行い、**どちらかが止めていれば止める**。

### リース（単一端末の実行権）

- `/heartbeat` が 200 を返せば、`terminal_id` がリースを **30秒** 保持する。5秒ごとに更新する。
- 別の端末が有効なリースを持っていると **409** が返る。この場合は新規・追加を出さず、保有の保護だけ続ける。
- 通信不能でリースの更新に失敗した状態が30秒続いたら、許可失効とみなし新規・追加を止める。

## 3ルールエンジンの責務（docs/SPEC.md §11）

| 項目 | ルールA改良版 `rule_a` | ドンチャン改良4 `donchian4` | ドンチャン改良6 `donchian6` |
| --- | --- | --- | --- |
| 判断する足 | 確定H1 | 確定H4 | 確定H4 |
| 準備 | D1/H4/H1で終値・SMA10がSMA90のトレンド側、SMA10の傾き（3本前）一致、直前8本H1がSMA16±0.35ATR14に接触、H1終値がD1 SMA10のトレンド側 | D1(傾き15本前)・H4(3本前)のSMA10/90と傾き一致、H1で押し目・戻り | 改良4と同じ |
| エントリー | H1 ADX14≥25、実体≥0.2ATR14、直前3本の高安突破、SMA10との距離<85pips | H4で直前24本の高安を厳密に突破、取引時間帯 | 改良4 + 確定H4終値が日次R1の上（買い）/S1の下（売り）。等値は見送り |
| 数量 | 共通lot | 共通lot | 想定損失60USD（費用込み）から切り下げ |
| 追加 | 同量を最大3回（M5終値がSMA20から逆方向に10pips以上） | なし | なし |
| SL | 原点までの距離×0.5 | ×1 | ×1 |
| TP | 3×SL距離 + 4×1.2pips | 同左 | 同左 |
| トレーリング | 100pipsで発動、M5 SMA20±10pips | 60pipsで発動、最高/最安から50pips | 60pipsで発動、最高/最安から30pips |
| 保有期限 | 18時間 または 次の05:00 JST | 48時間 または 土曜05:00 JST | 同左 |
| magic | 26061801 | 26101804 | 26101906 |

SL原点（買い）= min( min(直近5本H1安値) − 0.1×ATR14, H1判定終値 − 0.5×ATR14 )。売りは高値側へ反転。
実行は確定後30秒以内に最初に取得できた実勢Ask/Bid。遅れた条件を後追いで発注しない。
改良6の日足は **JST06:00（UTC21:00）区切り** でH1から集計する。A・改良4はブローカーD1。

## 安全ルール

1. **結果不明の注文は無条件に再送しない。** 注文意図を送信前に台帳へ原子的に記録し、約定・ポジションで照合する。照合できないときは新規・追加を止めて `stop_reasons` で報告する。
2. **ルールごとの台帳**（`state/rule-a.json`, `state/donchian-v4.json`, `state/donchian-v6.json`）で自分の管理対象だけを保護・決済する。手動や他システムのポジションは引き継がない。
3. 台帳を削除して停止理由を消さない。記録欠落時は、期間内の自己注文履歴がないことを確認できない限り停止する。
4. 通知の再試行（サーバー側）で注文は再送されない。約定イベントは `ticket+event` で冪等。
5. 共通lotの変更は次の新規から。保有中のAの追加は開始時のlotを維持する。
6. 改良6は最小数量でも60USDを超えるなら発注しない。数量決定後に最終価格で再検査する。
7. 口座番号・接続トークンをチャットやメールへ貼り付けない。

## 設定

環境変数または `lifeos_connector.ini`（`[lifeos]` セクション）:

```
LIFEOS_BASE_URL=https://dashboard.nami-tool.com
FX_CONNECTOR_TOKEN=...
TERMINAL_ID=win-home
MT5_PATH=C:\Program Files\MetaTrader 5\terminal64.exe
MT5_LOGIN=...
MT5_SERVER=...
```

## 実行

```
pip install requests MetaTrader5
python lifeos_connector.py --check   # 接続確認のみ（注文なし）
python lifeos_connector.py --once    # 1回だけ同期（注文なし）
python lifeos_connector.py           # 常駐
```

## TODO（本実装で埋める箇所）

- `MT5Adapter`: `MetaTrader5` パッケージでのログイン、`copy_rates_from_pos`、`symbol_info_tick`、`positions_get`、`history_deals_get`、`order_send`、`order_calc_profit`。
- `RuleAEngine` / `Donchian4Engine` / `Donchian6Engine`: 指標計算と条件判定（ここではSL/TP・数量・期限の式だけ実装済み）。
- 台帳の原子的な書き込みと起動時の照合。
- H1大量履歴（120日分）の初回共有とD1/H4の補完。
