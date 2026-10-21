#!/bin/bash
# Build and deploy the Life OS FX hub to the VPS. Run from the repo root: bash hub/deploy.sh
# Keeps hub.env and data/ on the server; restarts only the lifeos-fx-hub PM2 process.
set -euo pipefail
VPS="${VPS:-rocky@133.167.105.210}"
DIR="lifeos-fx-hub"
node hub/build.mjs
ssh "$VPS" "mkdir -p ~/$DIR/dist ~/$DIR/migrations ~/$DIR/data"
rsync -a --delete hub/dist/ "$VPS:$DIR/dist/"
rsync -a --delete migrations/ "$VPS:$DIR/migrations/"
rsync -a hub/ecosystem.config.cjs "$VPS:$DIR/"
ssh "$VPS" "source ~/.nvm/nvm.sh >/dev/null; cd ~/$DIR && (pm2 describe lifeos-fx-hub >/dev/null 2>&1 && pm2 restart lifeos-fx-hub --update-env || pm2 start ecosystem.config.cjs) >/dev/null && pm2 save >/dev/null && sleep 2 && curl -s 127.0.0.1:8790/health"
echo
