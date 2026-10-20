// The worker tsconfig only loads @cloudflare/workers-types, so declare the one Vite
// feature this module relies on (import.meta.glob) for the optional training NLP bridge.
interface ImportMeta {
  glob<T = unknown>(pattern: string | string[], opts?: { eager?: false; import?: string }): Record<string, () => Promise<T>>;
}
