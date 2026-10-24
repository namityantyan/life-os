#!/bin/zsh
# Life OS 画像生成: 自宅Macのセットアップ（ダブルクリックで実行。何度実行しても大丈夫です）
#   ~/LifeOS-imggen に Python・ComfyUI・モデル（Animagine XL 4.0, 約7GB）・画像生成サービスを入れ、
#   ログイン中は常に動くように launchd へ登録します（サービス・VPSへのトンネル・スリープ防止）。
# Python は uv（単体バイナリ, sha256 を照合）で ~/LifeOS-imggen の中に入れるので、Homebrew も管理者パスワードも不要です。
# git は Xcode Command Line Tools のものを使います。
set -u -o pipefail
SRC="${0:A:h}"
source "$SRC/lib/common.zsh" || { print -r -- "lib/common.zsh が見つかりません。zip を展開したフォルダから実行してください。"; exit 1; }

case "$PREFIX" in ""|/|"$HOME"|"$HOME/") print -r -- "インストール先が不正です: $PREFIX"; exit 1 ;; esac
mkdir -p "$PREFIX/logs" || { print -r -- "$PREFIX を作れません"; exit 1; }
LOG="$PREFIX/logs/setup-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
die() { fail "$1"; info "ログ: $LOG"; pause_exit 1; }
TOTAL=9

hr; print -r -- "${C_B}  Life OS 画像生成 — 自宅Macのセットアップ${C_0}"; print -r -- "  インストール先: $PREFIX"; hr

# ---- 1. 事前チェック ---------------------------------------------------------
step "1/$TOTAL" "このMacを確認しています"
[[ "$(uname -s)" == Darwin ]] || die "macOS 専用です。"
[[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" == 1 ]] || die "Apple Silicon（M1以降）のMacが必要です。"
[[ "$(uname -m)" == arm64 ]] || die "ターミナルが Rosetta で動いています。ターミナルの「情報を見る」で「Rosettaを使用して開く」を外してから実行してください。"
os_ver=$(sw_vers -productVersion); os_major=${os_ver%%.*}
(( os_major >= 14 )) || die "macOS 14 (Sonoma) 以降が必要です（このMac: $os_ver）。ソフトウェアアップデートで更新してください。"
mem_gb=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
ok "$(sysctl -n machdep.cpu.brand_string 2>/dev/null) / メモリ ${mem_gb}GB / macOS $os_ver"
(( mem_gb >= 16 )) || warn "メモリが ${mem_gb}GB です。生成に時間がかかるか、失敗することがあります。"
model_dest="$PREFIX/models/checkpoints/$MODEL_FILE"
need_gb=20
[[ -f "$model_dest" && "$(stat -f %z "$model_dest" 2>/dev/null)" == "$MODEL_SIZE" ]] && need_gb=5
gb=$(free_gb "$PREFIX")
[[ -n "$gb" ]] || die "空き容量を確認できません。"
(( gb >= need_gb )) || die "内蔵ディスクの空きが ${gb}GB です。${need_gb}GB 以上空けてから、もう一度実行してください。"
ok "空き容量 ${gb}GB"
if ! xcode-select -p >/dev/null 2>&1 || ! $GIT --version >/dev/null 2>&1; then
  warn "Xcode Command Line Tools（git などの基本ツール）が入っていません。"
  xcode-select --install >/dev/null 2>&1 || true
  info "画面に出た「インストール」を押して完了するまで待ち（10〜30分）、"
  info "終わったらこのファイルをもう一度ダブルクリックしてください。"
  info "画面が出ない場合: ターミナルで  xcode-select --install  を実行してください。"
  pause_exit 1
fi
ok "Xcode Command Line Tools ($($GIT --version))"
curl -fsS -m 15 -o /dev/null https://pypi.org/simple/ 2>/dev/null || die "インターネットに接続できません。Wi-Fi を確認してください。"
ok "インターネット接続"

# ---- 2. ファイルの配置・接続設定 -------------------------------------------
step "2/$TOTAL" "ファイルと接続設定を配置しています"
mkdir -p "$PREFIX"/{app,bin,lib,ssh,logs,workspace,cache,tools,models/checkpoints} || die "フォルダを作れません。"
if [[ "$SRC" != "$PREFIX" ]]; then
  cp -f "$SRC"/app/*.py "$SRC"/app/requirements-service.txt "$PREFIX/app/" && cp -f "$SRC"/bin/*.zsh "$PREFIX/bin/" && cp -f "$SRC"/lib/*.zsh "$PREFIX/lib/" \
    && cp -f "$SRC/constraints.txt" "$SRC/known_hosts" "$PREFIX/" && cp -f "$SRC"/*.command "$PREFIX/" || die "ファイルをコピーできません。"
fi
chmod 755 "$PREFIX"/bin/*.zsh "$PREFIX"/*.command
xattr -dr com.apple.quarantine "$PREFIX" 2>/dev/null || true
chmod 700 "$PREFIX/ssh"
cp -f "$PREFIX/known_hosts" "$PREFIX/ssh/known_hosts" && chmod 644 "$PREFIX/ssh/known_hosts"
sec="$SRC/secrets/secrets.env"; key="$SRC/secrets/tunnel_key"
if [[ -f "$sec" && -f "$key" ]]; then
  tok=$( set -a; source "$sec"; print -r -- "${IMGGEN_TOKEN:-}" )
  host=$( set -a; source "$sec"; print -r -- "${IMGGEN_TUNNEL_HOST:-}" )
  [[ -n "$tok" && -n "$host" ]] || die "secrets.env の内容が不完全です。zip をダウンロードし直してください。"
  port=$(config_get IMGGEN_PORT); port=${port:-$SVC_PORT_DEFAULT}
  ( umask 077; {
    print -r -- "# Life OS 画像生成の設定（セットアップが作成。zip から再セットアップすると上書きされます）"
    print -r -- "IMGGEN_TOKEN=${(qq)tok}"
    print -r -- "IMGGEN_TUNNEL_HOST=${(qq)host}"
    print -r -- "IMGGEN_PORT=$port"
  } > "$PREFIX/config.env.new" ) && mv -f "$PREFIX/config.env.new" "$PREFIX/config.env" || die "config.env を書けません。"
  ( umask 077; cp -f "$key" "$PREFIX/ssh/id_tunnel.new" ) && mv -f "$PREFIX/ssh/id_tunnel.new" "$PREFIX/ssh/id_tunnel" || die "鍵を配置できません。"
  ok "接続設定を書き込みました（config.env, ssh/id_tunnel）"
elif [[ -f "$PREFIX/config.env" && -f "$PREFIX/ssh/id_tunnel" ]]; then
  ok "既存の接続設定を使います"
else
  die "接続設定（secrets フォルダ）が見つかりません。Life OS の画像生成ページから zip をダウンロードし直してください。"
fi
chmod 600 "$PREFIX/config.env" "$PREFIX/ssh/id_tunnel"
ssh-keygen -y -f "$PREFIX/ssh/id_tunnel" >/dev/null 2>&1 || die "接続用の鍵を読めません（壊れているかパスフレーズ付き）。zip をダウンロードし直してください。"
ok "接続先 $(config_get IMGGEN_TUNNEL_HOST) / サービスのポート $(svc_port)"

# ---- 3. uv（Python の管理ツール） --------------------------------------------
step "3/$TOTAL" "uv $UV_VERSION を準備しています"
UV="$PREFIX/tools/uv-$UV_VERSION/uv"
if [[ -x "$UV" ]] && "$UV" --version 2>/dev/null | grep -q " $UV_VERSION"; then
  ok "導入済み"
else
  tmp=$(mktemp -d) || die "一時フォルダを作れません。"
  curl -fsSL --retry 5 --retry-delay 3 -o "$tmp/uv.tgz" "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-apple-darwin.tar.gz" || die "uv をダウンロードできません。"
  [[ "$(shasum -a 256 "$tmp/uv.tgz" | awk '{print $1}')" == "$UV_SHA256" ]] || die "uv のチェックサムが一致しません（ダウンロードが壊れています）。もう一度実行してください。"
  tar -xzf "$tmp/uv.tgz" -C "$tmp" && mkdir -p "${UV:h}" && mv -f "$tmp/uv-aarch64-apple-darwin/uv" "$UV" || die "uv を展開できません。"
  rm -rf "$tmp"
  ok "$("$UV" --version)（sha256 確認済み）"
fi

# ---- 4. Python と仮想環境 ----------------------------------------------------
step "4/$TOTAL" "Python $PY_VERSION を準備しています"
if "$PREFIX/venv/bin/python" -c "import sys; assert sys.version_info[:2] == tuple(map(int, '$PY_VERSION'.split('.')))" >/dev/null 2>&1; then
  ok "導入済み ($("$PREFIX/venv/bin/python" --version))"
else
  rm -rf "$PREFIX/venv"
  "$UV" python install --no-bin "$PY_VERSION" || die "Python をダウンロードできません。"
  "$UV" venv -q --python "$PY_VERSION" "$PREFIX/venv" || die "仮想環境を作れません。"
  ok "$("$PREFIX/venv/bin/python" --version)"
fi

# ---- 5. ComfyUI（固定バージョン） -------------------------------------------
step "5/$TOTAL" "ComfyUI を準備しています（${COMFY_COMMIT[1,10]}）"
comfy="$PREFIX/ComfyUI"
if [[ -d "$comfy/.git" && "$($GIT -C "$comfy" rev-parse HEAD 2>/dev/null)" == "$COMFY_COMMIT" ]]; then
  ok "導入済み"
else
  [[ -d "$comfy/.git" ]] || { rm -rf "$comfy"; $GIT init -q "$comfy" && $GIT -C "$comfy" remote add origin "$COMFY_REPO"; } || die "ComfyUI のフォルダを作れません。"
  $GIT -C "$comfy" fetch -q --depth 1 origin "$COMFY_COMMIT" || die "ComfyUI をダウンロードできません。"
  $GIT -C "$comfy" checkout -q --force FETCH_HEAD || die "ComfyUI を展開できません。"
  ok "$($GIT -C "$comfy" log -1 --format='%h %cd' --date=short)"
fi
cat > "$comfy/extra_model_paths.yaml" <<EOF || die "extra_model_paths.yaml を書けません。"
# Life OS 画像生成のセットアップが作成（再実行で上書き）。モデルは内蔵ディスクの ~/LifeOS-imggen/models に置く。
lifeos_imggen:
    base_path: $PREFIX/models
    checkpoints: checkpoints
    loras: loras
    vae: vae
    embeddings: embeddings
EOF
ok "モデルの場所: $PREFIX/models/checkpoints"

# ---- 6. Python パッケージ（PyTorch / MPS ほか） ------------------------------
step "6/$TOTAL" "PyTorch・ComfyUI の部品を入れています（初回は数分かかります）"
"$UV" pip install -q --python "$PREFIX/venv/bin/python" -r "$comfy/requirements.txt" -r "$PREFIX/app/requirements-service.txt" -c "$PREFIX/constraints.txt" \
  || die "パッケージを入れられません。ネットワークを確認して、もう一度実行してください。"
mps=$("$PREFIX/venv/bin/python" -c "import torch, fastapi, uvicorn; print(torch.__version__, torch.backends.mps.is_available())" 2>/dev/null) || die "PyTorch を読み込めません。"
[[ "$mps" == *True ]] || die "このMacでは GPU（MPS）が使えません（$mps）。"
ok "torch ${mps% *} / GPU（MPS）利用可"

# ---- 7. モデル（Animagine XL 4.0） --------------------------------------------
step "7/$TOTAL" "モデル Animagine XL 4.0 を準備しています（約7GB）"
verify_model() { [[ "$(shasum -a 256 "$1" | awk '{print $1}')" == "$MODEL_SHA256" ]]; }
download_model() {
  local dest="$model_dest" part="$model_dest.part" marker="$model_dest.verified" size i
  if [[ -f "$dest" ]]; then
    size=$(stat -f %z "$dest")
    if [[ "$size" == "$MODEL_SIZE" && -f "$marker" && "$(<"$marker")" == "$MODEL_SHA256 $size" ]]; then ok "ダウンロード済み（確認済み）"; return 0; fi
    if [[ "$size" == "$MODEL_SIZE" ]]; then
      info "ダウンロード済みのファイルを確認しています（1分ほど）"
      if verify_model "$dest"; then print -r -- "$MODEL_SHA256 $size" > "$marker"; ok "確認しました"; return 0; fi
      warn "ファイルが壊れているため、ダウンロードし直します"
    fi
    rm -f "$dest" "$marker"
  fi
  for i in {1..30}; do
    size=$(stat -f %z "$part" 2>/dev/null || print 0)
    (( size > MODEL_SIZE )) && { rm -f "$part"; size=0; }
    (( size == MODEL_SIZE )) && break
    (( size > 0 )) && info "続きからダウンロードします（$(( size / 1048576 ))MB / $(( MODEL_SIZE / 1048576 ))MB）"
    curl -fL --progress-bar --connect-timeout 30 --speed-limit 10240 --speed-time 120 --retry 5 --retry-delay 5 --retry-all-errors -C - -o "$part" "$MODEL_URL" && continue
    warn "ダウンロードが中断しました（$i 回目）。10秒後に続きから再開します"
    sleep 10
  done
  size=$(stat -f %z "$part" 2>/dev/null || print 0)
  [[ "$size" == "$MODEL_SIZE" ]] || { fail "モデルをダウンロードしきれませんでした（${size} / ${MODEL_SIZE} バイト）。もう一度実行すると続きから再開します。"; return 1; }
  info "ファイルを確認しています（sha256, 1分ほど）"
  verify_model "$part" || { rm -f "$part"; fail "モデルのチェックサムが一致しません。もう一度実行してください。"; return 1; }
  mv -f "$part" "$dest" && print -r -- "$MODEL_SHA256 $MODEL_SIZE" > "$marker" || return 1
  ok "ダウンロードして確認しました（sha256 一致）"
}
if [[ -n "${LIFEOS_IMGGEN_SKIP_MODEL:-}" ]]; then warn "（テスト）モデルのダウンロードを省略しました"
else download_model || die "モデルを準備できません。"; fi

# ---- 8. 常駐の登録（launchd） -----------------------------------------------
step "8/$TOTAL" "常駐を登録しています（サービス・トンネル・スリープ防止）"
xml() { local s=$1; s=${s//&/&amp;}; s=${s//</&lt;}; s=${s//>/&gt;}; print -r -- "$s"; }
write_plist() { # label, program args...
  local label=$1; shift; local a args=""
  for a in "$@"; do args+="<string>$(xml "$a")</string>"; done
  cat > "$(plist_path "$label")" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>WorkingDirectory</key><string>$(xml "$PREFIX")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$PREFIX/logs/${label#com.lifeos.}.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$PREFIX/logs/${label#com.lifeos.}.log")</string>
</dict></plist>
EOF
}
mkdir -p "$LA_DIR" || die "$LA_DIR を作れません。"
for l in $LABELS; do agent_stop "$l"; done
pkill -f "$PREFIX/venv/bin/python main.py" 2>/dev/null || true
write_plist com.lifeos.imggen-svc /bin/zsh "$PREFIX/bin/service.zsh" || die "plist を書けません。"
write_plist com.lifeos.imggen-tunnel /bin/zsh "$PREFIX/bin/tunnel.zsh" || die "plist を書けません。"
write_plist com.lifeos.imggen-awake /usr/bin/caffeinate -s -i || die "plist を書けません。"
for l in $LABELS; do plutil -lint -s "$(plist_path "$l")" || die "plist が不正です: $l"; done
for l in $LABELS; do agent_start "$l" || die "常駐を登録できません: $l"; done
ok "登録しました: ${(j:, :)LABELS}"

# ---- 9. 動作確認 -------------------------------------------------------------
step "9/$TOTAL" "動作を確認しています"
if [[ -n "${LIFEOS_IMGGEN_NO_LAUNCHD:-}" ]]; then
  warn "（テスト）常駐を起動していないため、動作確認は省略しました"
else
  h=""; for i in {1..45}; do h=$(health); [[ "${h%% *}" == 200 || "${h%% *}" == 503 ]] && break; sleep 2; done
  case "${h%% *}" in
    200) ok "画像生成サービス: 正常（${h#* }）" ;;
    503) warn "画像生成サービスは起動しましたが、まだ生成できません（${h#* }）" ;;
    *) fail "画像生成サービスが応答しません。ログ: $PREFIX/logs/imggen-svc.log"; tail -n 15 "$PREFIX/logs/imggen-svc.log" 2>/dev/null ;;
  esac
  sleep 8
  if pgrep -f "ssh -N .*$PREFIX/ssh/id_tunnel" >/dev/null; then ok "VPS へのトンネル: 接続中"
  else fail "VPS へのトンネルがつながっていません（自動で再接続を続けます）。ログ:"; tail -n 8 "$PREFIX/logs/imggen-tunnel.log" 2>/dev/null; fi
  agent_loaded com.lifeos.imggen-awake && ok "スリープ防止: 有効（電源アダプタ接続中のみ）" || warn "スリープ防止が動いていません"
fi

print -r -- ""; hr
print -r -- "${C_B}  セットアップが終わりました${C_0}"; hr
print -r -- "  1. このMacは電源アダプタにつなぎ、ふたを開けたままにしてください（画面は消えても大丈夫です）。"
print -r -- "     ふたを閉じる・バッテリー駆動にするとスリープして、画像生成は止まります。"
print -r -- "  2. Life OS の画像生成ページを開き、右上が「接続中」になれば使えます。"
print -r -- "     1回目の生成は準備（ComfyUI の起動とモデルの読み込み）で 1〜2 分余分にかかります。"
print -r -- "  3. 状態確認・アンインストールは $PREFIX の中の .command からいつでも実行できます。"
print -r -- "  4. ダウンロードした zip と展開したフォルダには接続用の鍵が入っています。終わったら削除してください。"
print -r -- "  ログイン中は自動で動き続けます（再起動後もログインすれば自動で再開）。"
print -r -- "  ログ: $LOG"
pause_exit 0
