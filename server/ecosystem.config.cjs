// PM2 config for the self-hosted Life OS on the VPS. Secrets live in server.env next to this file (chmod 600).
// Start: pm2 start ecosystem.config.cjs && pm2 save
const fs = require("fs");
const path = require("path");
const env = {};
const file = path.join(__dirname, "server.env");
if (fs.existsSync(file)) for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2];
}
module.exports = { apps: [{
  name: "lifeos", script: "dist/lifeos-server.mjs", interpreter: "node", node_args: "--no-warnings", cwd: __dirname,
  autorestart: true, max_restarts: 50, restart_delay: 3000,
  env: { BIND: "127.0.0.1", PORT: "8791", LIFEOS_ROOT: __dirname, ...env },
}] };
