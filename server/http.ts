// Response compression and in-memory static files for the self-hosted server (nginx in front sends no gzip).
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as Z } from "node:zlib";

const br = promisify(brotliCompress), gz = promisify(gzip);
export type Encoding = "br" | "gzip";
export const MIN_COMPRESS_BYTES = 1024;

/** Best encoding the client accepts (br > gzip), honouring `;q=0`. */
export function pickEncoding(accept: string | null | undefined): Encoding | null {
  const ok = new Map<string, boolean>();
  for (const part of (accept ?? "").toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    ok.set(name.trim(), !q || Number(q.slice(2)) > 0);
  }
  if (ok.get("br")) return "br";
  if (ok.get("gzip") || (ok.get("*") && ok.get("gzip") !== false)) return "gzip";
  return null;
}
/** Text-like types worth compressing. Never event streams (they must flush as they go). */
export const isCompressible = (type: string | null | undefined) => !!type && !/event-stream/i.test(type) && /^(text\/|application\/(json|javascript|manifest\+json|xml|[\w.+-]+\+json)|image\/svg\+xml)/i.test(type);
/** Brotli quality 5 for on-the-fly responses (fast, ~gzip-9 size); 11 for build-time precompression. */
export const compressBuf = (buf: Uint8Array, enc: Encoding, quality = 5) => enc === "br"
  ? br(buf, { params: { [Z.BROTLI_PARAM_QUALITY]: quality, [Z.BROTLI_PARAM_SIZE_HINT]: buf.byteLength } })
  : gz(buf, { level: quality >= 11 ? 9 : 6 });
const addVary = (h: Headers) => { const v = h.get("Vary"); if (!v) h.set("Vary", "Accept-Encoding"); else if (!/accept-encoding|\*/i.test(v)) h.set("Vary", `${v}, Accept-Encoding`); };

/** Compresses a buffered text response (API JSON etc.) when the client accepts it and it is ≥ 1 KB. */
export async function compressResponse(res: Response, accept: string | null | undefined): Promise<Response> {
  const type = res.headers.get("Content-Type");
  if (!res.body || res.status === 204 || res.status === 304 || res.status === 206 || res.headers.has("Content-Encoding") || !isCompressible(type)) return res;
  const len = Number(res.headers.get("Content-Length") ?? NaN);
  if (Number.isFinite(len) && len < MIN_COMPRESS_BYTES) return res;
  const enc = pickEncoding(accept);
  const headers = new Headers(res.headers); addVary(headers);
  const init = { status: res.status, statusText: res.statusText, headers };
  if (!enc) return new Response(res.body, init);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < MIN_COMPRESS_BYTES) return new Response(buf, init);
  headers.set("Content-Encoding", enc); headers.delete("Content-Length");
  const etag = headers.get("ETag"); if (etag && !etag.startsWith("W/")) headers.set("ETag", `W/${etag}`);
  return new Response(new Uint8Array(await compressBuf(buf, enc)), init);
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json", ".txt": "text/plain; charset=utf-8" };
type Entry = { body: Uint8Array; type: string; etag: string; cache: string; enc: Partial<Record<Encoding, Uint8Array | Promise<Uint8Array>>> };

/**
 * Static assets with SPA fallback (same as Workers assets "single-page-application"). Files are read once and
 * kept in memory (the client dir only changes on deploy, which restarts the process), served with a strong ETag
 * (304 on If-None-Match), and compressed: build-time `.br`/`.gz` siblings when present, else compressed once lazily.
 * /assets/* (hashed) are immutable; everything else (index.html, sw.js, manifest) is no-cache.
 */
export function staticFiles(root: string) {
  const files = new Map<string, Entry>();
  const load = (file: string): Entry | null => {
    const hit = files.get(file); if (hit) return hit;
    let e: Entry | null = null; // misses (SPA routes) aren't cached, so unknown URLs can't grow the map
    if (file.startsWith(root) && existsSync(file) && !statSync(file).isDirectory()) {
      const body = new Uint8Array(readFileSync(file));
      const enc: Entry["enc"] = {};
      for (const [k, ext] of [["br", ".br"], ["gzip", ".gz"]] as const) if (existsSync(file + ext)) enc[k] = new Uint8Array(readFileSync(file + ext));
      const rel = file.slice(root.length).replace(/\\/g, "/");
      e = { body, enc, type: MIME[extname(file)] ?? "application/octet-stream", etag: `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`, cache: rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" };
      files.set(file, e);
    }
    return e;
  };
  return {
    async fetch(req: Request | string) {
      const r = typeof req === "string" ? new Request(req) : req;
      const url = new URL(r.url);
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      const e = (/\.(br|gz)$/.test(rel) ? null : load(join(root, rel))) ?? load(join(root, "index.html"));
      if (!e) return new Response("not found", { status: 404 });
      const compressible = isCompressible(e.type) && e.body.byteLength >= MIN_COMPRESS_BYTES;
      const enc = compressible ? pickEncoding(r.headers.get("Accept-Encoding")) : null;
      // Each encoding is its own representation → its own ETag ("<hash>-br"); any of them revalidates.
      const headers = new Headers({ "Content-Type": e.type, "Cache-Control": e.cache, ETag: enc ? `${e.etag.slice(0, -1)}-${enc}"` : e.etag });
      if (compressible) headers.set("Vary", "Accept-Encoding");
      const tags = (r.headers.get("If-None-Match") ?? "").split(",").map((t) => t.trim().replace(/^W\//, "").replace(/-(br|gzip)"$/, '"'));
      if (tags.includes(e.etag)) return new Response(null, { status: 304, headers });
      if (enc) {
        const body = await (e.enc[enc] ??= compressBuf(e.body, enc).then((b) => (e.enc[enc] = new Uint8Array(b))));
        headers.set("Content-Encoding", enc);
        return new Response(r.method === "HEAD" ? null : body, { headers });
      }
      return new Response(r.method === "HEAD" ? null : e.body, { headers });
    },
  };
}
