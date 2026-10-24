import { zipSync, strToU8 } from "fflate";

export type ZipFile = { data: string | Uint8Array; mode?: number };
/**
 * Zip whose entries carry Unix permissions ("made by" = Unix). macOS Archive Utility and `unzip` restore the mode,
 * so shell scripts stay executable and secrets stay owner-only after a double-click unzip. Default mode 0644.
 */
export function zipWithModes(files: Record<string, ZipFile>, mtime: Date = new Date()): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, f]) => [path, [typeof f.data === "string" ? strToU8(f.data) : f.data, { os: 3, attrs: (0o100000 | (f.mode ?? 0o644)) << 16, mtime }]])), { level: 6 });
}
