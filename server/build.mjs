// Bundles the self-hosted server into dist/lifeos-server.mjs (`?raw` imports inlined, @shared aliased).
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const raw = { name: "raw", setup(b) {
  b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace(/\?raw$/, "")), namespace: "raw" }));
  b.onLoad({ filter: /.*/, namespace: "raw" }, async (a) => ({ contents: await readFile(a.path, "utf8"), loader: "text" }));
} };
await build({
  entryPoints: [resolve(here, "server.ts")], outfile: resolve(here, "dist/lifeos-server.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", sourcemap: true, logLevel: "info",
  alias: { "@shared": resolve(here, "../shared") }, external: ["node:*"], plugins: [raw],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// Precompress the client build (dist/client) so the server can send .br/.gz as is (server/http.ts staticFiles).
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants as Z } from "node:zlib";
const client = resolve(here, "../dist/client");
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
if (existsSync(client)) {
  let n = 0;
  for (const f of walk(client)) {
    if (!/\.(html|js|mjs|css|json|svg|webmanifest|txt|map)$/.test(f)) continue;
    const buf = readFileSync(f); if (buf.length < 1024) continue;
    writeFileSync(`${f}.br`, brotliCompressSync(buf, { params: { [Z.BROTLI_PARAM_QUALITY]: 11, [Z.BROTLI_PARAM_SIZE_HINT]: buf.length } }));
    writeFileSync(`${f}.gz`, gzipSync(buf, { level: 9 })); n++;
  }
  console.log(`precompressed ${n} client files (.br/.gz)`);
}
