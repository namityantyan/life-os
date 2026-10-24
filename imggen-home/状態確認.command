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
m="$PREFIX/models/checkpoints/$MODEL_FILE"
if [[ -f "$m" && -f "$m.verified" ]]; then ok "モデル: $(( $(stat -f %z "$m") / 1048576 ))MB（確認済み）"
elif [[ -f "$m.part" ]]; then warn "モデル: ダウンロード途中 $(( $(stat -f %z "$m.part") / 1048576 ))MB / $(( MODEL_SIZE / 1048576 ))MB（セットアップを再実行すると続きから）"
else fail "モデル: ありません（セットアップを再実行してください）"; fi
info "内蔵ディスクの空き: $(free_gb "$PREFIX")GB"
pmset -g batt 2>/dev/null | grep -q "AC Power" && ok "電源アダプタ: 接続中" || warn "電源アダプタ: 未接続（バッテリー駆動中はスリープして生成が止まります）"
{ pmset -g assertions 2>/dev/null | grep -qi caffeinate || pgrep -xq caffeinate; } && ok "スリープ防止: 有効" || warn "スリープ防止: 無効"

step "最近のサービスログ" ""
[[ -f "$PREFIX/logs/imggen-svc.log" ]] && tail -n 8 "$PREFIX/logs/imggen-svc.log" | sed 's/^/    /'
pause_exit 0
