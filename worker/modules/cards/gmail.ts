// Gmail API search for 三井住友カード usage-notification mail (requires a stored gmail.readonly token).
import type { Env } from "../../env";
import { all, run, newId } from "../../core/db";
import { loadToken, saveToken } from "../assets/freee";
import { parseSmbcMail } from "./logic";

/** expires_at is an ISO string (written by the integrations module); legacy ms numbers are still accepted. */
type GToken = { access_token: string; refresh_token?: string; expires_at?: string | number; scope?: string };
export const GMAIL_QUERY = "from:(smbc-card.com) subject:(ご利用のお知らせ)";
const expiresMs = (v: string | number | undefined) => (v == null ? 0 : typeof v === "number" ? v : Date.parse(v) || 0);

/** Stored gmail token, refreshed when expired (shared with finance invoice-mail scan). */
export async function validGmailToken(env: Env, userId: string): Promise<GToken | null> {
  const t = await loadToken(env, userId, "gmail") as unknown as GToken | null;
  if (!t) return null;
  if (expiresMs(t.expires_at) > Date.now() + 60_000) return t;
  if (!t.refresh_token || !env.GOOGLE_CLIENT_ID) return t;
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET ?? "", refresh_token: t.refresh_token, grant_type: "refresh_token" }) });
  if (!res.ok) throw new Error(`gmail token refresh: ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  const n = { ...t, access_token: j.access_token, expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString() };
  await saveToken(env, userId, n, "gmail");
  return n;
}
const b64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
function bodyOf(p: any): string {
  if (!p) return "";
  if (p.body?.data && (!p.mimeType || p.mimeType.startsWith("text/"))) return b64url(p.body.data);
  for (const part of p.parts ?? []) { const t = bodyOf(part); if (t) return t; }
  return "";
}

export async function syncGmail(env: Env, userId: string, opts: { days?: number } = {}): Promise<{ connected: boolean; found: number; imported: number; errors: string[] }> {
  const t = await validGmailToken(env, userId);
  if (!t) return { connected: false, found: 0, imported: 0, errors: [] };
  const q = `${GMAIL_QUERY} newer_than:${opts.days ?? 60}d`;
  const H = { Authorization: `Bearer ${t.access_token}` };
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=200`, { headers: H });
  if (!list.ok) throw new Error(`gmail list: ${list.status}`);
  const ids = ((await list.json()) as { messages?: { id: string }[] }).messages ?? [];
  const known = new Set((await all<{ external_id: string }>(env.DB, "SELECT external_id FROM card_transactions WHERE user_id=? AND source='gmail' AND external_id IS NOT NULL", userId)).map((r) => r.external_id));
  let imported = 0; const errors: string[] = [];
  for (const m of ids) {
    if (known.has(m.id)) continue;
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: H });
    if (!r.ok) { errors.push(`message ${m.id}: ${r.status}`); continue; }
    const msg = (await r.json()) as any;
    const subject = (msg.payload?.headers ?? []).find((h: any) => h.name?.toLowerCase() === "subject")?.value ?? "";
    const parsed = parseSmbcMail(subject, bodyOf(msg.payload));
    if (!parsed) { errors.push(`message ${m.id}: 本文を解析できません`); continue; }
    await run(env.DB, "INSERT INTO card_transactions (id,user_id,used_at,merchant,amount,source,external_id,status) VALUES (?,?,?,?,?,'gmail',?,'approved')", newId(), userId, parsed.used_at, parsed.merchant, parsed.amount, m.id);
    imported++;
  }
  return { connected: true, found: ids.length, imported, errors };
}
