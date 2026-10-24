#!/bin/zsh
# Life OS 画像生成: 自宅Macからの削除（ダブルクリックで実行）
#   常駐（launchd の3つ）を止めて登録を外します。~/LifeOS-imggen（モデル約7GBを含む）を消すかは選べます。
set -u -o pipefail
source "${0:A:h}/lib/common.zsh" 2>/dev/null || source "${LIFEOS_IMGGEN_PREFIX:-$HOME/LifeOS-imggen}/lib/common.zsh" || { print -r -- "lib/common.zsh が見つかりません。"; exit 1; }

hr; print -r -- "${C_B}  Life OS 画像生成 — アンインストール${C_0}"; hr
print -rn -- "  常駐を止めて登録を外します。よろしいですか？ [y/N]: "; read -r a || a=""
[[ "$a" == [yY]* ]] || { info "中止しました。"; pause_exit 0; }
for l in $LABELS; do agent_stop "$l"; rm -f "$(plist_path "$l")"; ok "$l を停止・削除"; done
pkill -f "$PREFIX/venv/bin/python main.py" 2>/dev/null || true
pkill -f "ssh -N .*$PREFIX/ssh/id_tunnel" 2>/dev/null || true

case "$PREFIX" in ""|/|"$HOME"|"$HOME/") fail "インストール先が不正なため、フォルダは消しません: $PREFIX"; pause_exit 1 ;; esac
if [[ -d "$PREFIX" ]]; then
  print -r -- ""
  print -r -- "  $PREFIX には Python・ComfyUI・モデル（約7GB）・生成した画像（workspace）・接続用の鍵があります。"
  print -rn -- "  このフォルダも削除しますか？（元に戻せません） [y/N]: "; read -r b || b=""
  if [[ "$b" == [yY]* ]]; then
    cd / && rm -rf "$PREFIX" && ok "削除しました: $PREFIX" || fail "削除できませんでした: $PREFIX"
  else
    ok "フォルダは残しました（セットアップを再実行すると、ダウンロードなしで元に戻せます）"
  fi
fi
print -r -- ""; ok "アンインストールが終わりました。"
pause_exit 0
