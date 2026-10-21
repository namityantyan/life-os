// PM2 config for the Life OS FX hub on the VPS (same style as the old kintore-bot / life-dashboard apps).
// Secrets live in hub.env next to this file (never committed). Start: pm2 start ecosystem.config.cjs && pm2 save
const fs = require("fs");
const path = require("path");
const envFile = path.join(__dirname, "hub.env");
const env = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
}
module.exports = {
  apps: [{
    name: "lifeos-fx-hub",
    script: "dist/fx-hub.mjs",
    interpreter: "node",
    node_args: "--no-warnings",
    cwd: __dirname,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 3000,
    env: { FX_HUB_BIND: "127.0.0.1", FX_HUB_PORT: "8790", FX_HUB_DATA_DIR: path.join(__dirname, "data"), FX_HUB_MIGRATIONS_DIR: path.join(__dirname, "migrations"), ...env },
  }],
};
