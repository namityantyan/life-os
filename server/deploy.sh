#!/bin/bash
# Build and deploy Life OS to the VPS (code only; server.env and data/ stay). Run from the repo root.
set -euo pipefail
VPS="${VPS:-rocky@133.167.105.210}"; DIR="lifeos"
npx vite build >/dev/null
node server/build.mjs
ssh "$VPS" "mkdir -p ~/$DIR/dist ~/$DIR/client ~/$DIR/migrations ~/$DIR/data"
rsync -a --delete server/dist/ "$VPS:$DIR/dist/"
rsync -a --delete dist/client/ "$VPS:$DIR/client/"
rsync -a --delete migrations/ "$VPS:$DIR/migrations/"
rsync -a server/ecosystem.config.cjs "$VPS:$DIR/"
ssh "$VPS" "source ~/.nvm/nvm.sh >/dev/null; cd ~/$DIR && (pm2 describe lifeos >/dev/null 2>&1 && pm2 restart lifeos --update-env || pm2 start ecosystem.config.cjs) >/dev/null && pm2 save >/dev/null && sleep 2 && curl -s 127.0.0.1:8791/api/health"
echo
