#!/bin/zsh
# Life OS 画像生成: 自宅Macの状態確認（ダブルクリックで実行。何も変更しません）
set -u -o pipefail
source "${0:A:h}/lib/common.zsh" 2>/dev/null || source "${LIFEOS_IMGGEN_PREFIX:-$HOME/LifeOS-imggen}/lib/common.zsh" || { print -r -- "lib/common.zsh が見つかりません。"; exit 1; }

hr; print -r -- "${C_B}  Life OS 画像生成 — 状態確認${C_0}  $(date '+%Y-%m-%d %H:%M')"; print -r -- "  インストール先: $PREFIX"; hr
[[ -d "$PREFIX" ]] || { fail "まだセットアップされていません。LifeOS-画像生成-セットアップ.command を実行してください。"; pause_exit 1; }

step "常駐" ""
for l in $LABELS; do
  if agent_loaded "$l"; then
    st=$(launchctl print "$(uid_domain)/$l" 2>/dev/null | awk -F'= ' '/^\tstate = /{print $2; exit}')
    pid=$(launchctl print "$(uid_domain)/$l" 2>/dev/null | awk -F'= ' '/^\tpid = /{print $2; exit}')
    [[ "$st" == running ]] && ok "$l: 動作中 (pid $pid)" || warn "$l: ${st:-不明}"
  else fail "$l: 登録されていません（セットアップを実行してください）"; fi
done

step "画像生成サービス" ""
h=$(health)
case "${h%% *}" in
  200) ok "正常 ${h#* }" ;;
  503) warn "起動していますが生成できません ${h#* }" ;;
  401) fail "トークンが一致しません（zip をダウンロードし直してセットアップしてください）" ;;
  *) fail "応答なし（ログ: $PREFIX/logs/imggen-svc.log）" ;;
esac
pgrep -f "$PREFIX/venv/bin/python main.py" >/dev/null && ok "ComfyUI: 起動中" || info "ComfyUI: 停止中（最初の生成のときに自動で起動します）"

step "VPS へのトンネル" ""
pgrep -f "ssh -N .*$PREFIX/ssh/id_tunnel" >/dev/null && ok "接続中（$(config_get IMGGEN_TUNNEL_HOST)）" || fail "つながっていません（自動で再接続を続けます）"
[[ -f "$PREFIX/logs/imggen-tunnel.log" ]] && tail -n 4 "$PREFIX/logs/imggen-tunnel.log" | sed 's/^/    /'

step "モデル・ディスク・電源" ""
st=(${(s: :)$(model_state "$MODEL_FILE")})
case $st[1] in
  ok) ok "アニメのモデル（Animagine XL 4.0）: $st[2]MB（確認済み）" ;;
  part) warn "アニメのモデル: ダウンロード途中 $st[2]MB / $(( MODEL_SIZE / 1048576 ))MB（セットアップを再実行すると続きから）" ;;
  *) fail "アニメのモデル: ありません（セットアップを再実行してください）" ;;
esac
st=(${(s: :)$(model_state "$PHOTO_MODEL_FILE")})
case $st[1] in
  ok) ok "実写のモデル（RealVisXL V5.0）: $st[2]MB（確認済み）" ;;
  part) warn "実写のモデル: ダウンロード途中 $st[2]MB / $(( PHOTO_MODEL_SIZE / 1048576 ))MB（セットアップを再実行すると続きから）" ;;
  *) warn "実写のモデル: ありません（空きを約10GB作ってからセットアップを再実行すると追加されます。アニメだけでも動きます）" ;;
esac
info "内蔵ディスクの空き: $(free_gb "$PREFIX")GB"
pmset -g batt 2>/dev/null | grep -q "AC Power" && ok "電源アダプタ: 接続中" || warn "電源アダプタ: 未接続（バッテリー駆動中はスリープして生成が止まります）"
{ pmset -g assertions 2>/dev/null | grep -qi caffeinate || pgrep -xq caffeinate; } && ok "スリープ防止: 有効" || warn "スリープ防止: 無効"

step "最近のサービスログ" ""
[[ -f "$PREFIX/logs/imggen-svc.log" ]] && tail -n 8 "$PREFIX/logs/imggen-svc.log" | sed 's/^/    /'
pause_exit 0
