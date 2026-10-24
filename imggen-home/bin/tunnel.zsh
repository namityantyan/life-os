#!/bin/zsh
# launchd (com.lifeos.imggen-tunnel): reverse SSH tunnel VPS 127.0.0.1:18787 -> this Mac 127.0.0.1:IMGGEN_PORT.
# Before each connect it runs the server-side forced command "cleanup", which frees a stale listener on 18787
# (e.g. a dead session from a sleep/wake). Reconnects forever with backoff (5 s .. 5 min).
set -u
PREFIX="${0:A:h:h}"
set -a; source "$PREFIX/config.env"; set +a
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
HOST="${IMGGEN_TUNNEL_HOST:-rocky@133.167.105.210}"
KEY="$PREFIX/ssh/id_tunnel"
LOCAL_PORT="${IMGGEN_PORT:-8787}"
# -F /dev/null: ignore ~/.ssh/config so nothing on this Mac changes how the tunnel connects. Host key is pinned.
OPTS=(-F /dev/null -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile="$PREFIX/ssh/known_hosts"
  -o StrictHostKeyChecking=yes -o ConnectTimeout=20)
ts() { date '+%Y-%m-%d %H:%M:%S'; }
backoff=5
while true; do
  print -r -- "$(ts) cleanup: $HOST"
  /usr/bin/ssh "${OPTS[@]}" "$HOST" cleanup; rc=$?
  (( rc == 0 )) || print -r -- "$(ts) cleanup に失敗（ssh 終了コード $rc、接続は続行）"
  print -r -- "$(ts) トンネル接続: VPS 127.0.0.1:18787 -> 127.0.0.1:$LOCAL_PORT"
  started=$(date +%s)
  /usr/bin/ssh -N "${OPTS[@]}" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R "18787:127.0.0.1:$LOCAL_PORT" "$HOST"
  rc=$?
  (( $(date +%s) - started > 120 )) && backoff=5
  print -r -- "$(ts) トンネル切断 (ssh 終了コード $rc)。${backoff} 秒後に再接続します"
  sleep $backoff
  (( backoff = backoff * 2 > 300 ? 300 : backoff * 2 ))
done
