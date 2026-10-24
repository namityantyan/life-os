#!/bin/sh
# Run on the VPS (as rocky) to register the restricted SSH key the home Mac uses for the image tunnel:
#   ssh rocky@133.167.105.210 'sh -s' < server/setup-imggen-tunnel-key.sh
# The key can only open the remote forward 127.0.0.1:18787 and run "cleanup" (frees a stale listener). No shell.
# Safe to re-run.
set -e
mkdir -p ~/bin ~/lifeos/data/imggen-tunnel
chmod 700 ~/lifeos/data/imggen-tunnel

cat > ~/bin/imggen-tunnel-gate <<'EOF'
#!/bin/sh
# Forced command for the home-Mac image tunnel key. Only "cleanup" is allowed:
# it frees 127.0.0.1:18787 when a dead tunnel session still holds it.
case "$SSH_ORIGINAL_COMMAND" in
  cleanup)
    pid=$(sudo -n ss -ltnp "sport = :18787" 2>/dev/null | grep -o 'sshd-session",pid=[0-9]*' | grep -o '[0-9]*$' | head -1)
    if [ -n "$pid" ] && [ "$(ps -o user= -p "$pid" | tr -d ' ')" = "rocky" ]; then kill "$pid" && echo freed; else echo free; fi ;;
  *) echo "not allowed" >&2; exit 1 ;;
esac
EOF
chmod 755 ~/bin/imggen-tunnel-gate

K="$HOME/lifeos/data/imggen-tunnel/id_ed25519"
[ -f "$K" ] || ssh-keygen -q -t ed25519 -N "" -C "lifeos-imggen-home" -f "$K"
chmod 600 "$K"
grep -q "lifeos-imggen-home" ~/.ssh/authorized_keys || \
  echo "restrict,port-forwarding,permitlisten=\"localhost:18787\",command=\"$HOME/bin/imggen-tunnel-gate\" $(cat "$K.pub")" >> ~/.ssh/authorized_keys

grep -q "^IMGGEN_TUNNEL_KEY=" ~/lifeos/server.env || echo "IMGGEN_TUNNEL_KEY=$K" >> ~/lifeos/server.env
grep -q "^IMGGEN_TUNNEL_HOST=" ~/lifeos/server.env || echo "IMGGEN_TUNNEL_HOST=rocky@133.167.105.210" >> ~/lifeos/server.env
echo "登録しました（制限付きの鍵: $(grep -c lifeos-imggen-home ~/.ssh/authorized_keys) 件）"
