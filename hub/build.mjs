// Bundles the hub into one ESM file (dist/fx-hub.mjs). `?raw` imports (connector sources used by the
// install endpoint) are inlined as text; @shared resolves to ../shared.
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
  entryPoints: [resolve(here, "server.ts")], outfile: resolve(here, "dist/fx-hub.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", sourcemap: true, logLevel: "info",
  alias: { "@shared": resolve(here, "../shared") }, external: ["node:*"], plugins: [raw],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
