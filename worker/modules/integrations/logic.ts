// Pure helpers for the integrations module (no D1/KV): scope mapping, token shaping, status shaping.

export type GoogleScopeKey = "calendar" | "gmail";
export type GoogleProvider = "google_calendar" | "gmail";
export type Provider = GoogleProvider | "oura" | "freee";

export const GOOGLE_SCOPES: Record<GoogleScopeKey, string> = {
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
};
export const SCOPE_PROVIDER: Record<GoogleScopeKey, GoogleProvider> = { calendar: "google_calendar", gmail: "gmail" };
export const GOOGLE_PROVIDERS: GoogleProvider[] = ["google_calendar", "gmail"];

/** `?scopes=calendar,gmail` → unique known keys (defaults to both when empty). */
export function parseRequestedScopes(raw: string | undefined | null): GoogleScopeKey[] {
  const keys = (raw ?? "").split(",").map((s) => s.trim()).filter((s): s is GoogleScopeKey => s === "calendar" || s === "gmail");
  const uniq = [...new Set(keys)];
  return uniq.length ? uniq : ["calendar", "gmail"];
}

/** Space-separated `scope` value for the Google authorization URL. */
export function scopeParam(keys: GoogleScopeKey[]): string {
  return keys.map((k) => GOOGLE_SCOPES[k]).join(" ");
}

/**
 * Map the `scope` string Google returns with the token to the providers whose consumers can use it.
 * Any calendar.* scope satisfies google_calendar, any gmail.* scope satisfies gmail (readonly is what we ask for).
 */
export function providersForGrantedScopes(granted: string | undefined | null): GoogleProvider[] {
  const parts = (granted ?? "").split(/\s+/).filter(Boolean);
  const out = new Set<GoogleProvider>();
  for (const p of parts) {
    if (/^https:\/\/www\.googleapis\.com\/auth\/calendar(\.|$)/.test(p)) out.add("google_calendar");
    if (/^https:\/\/www\.googleapis\.com\/auth\/gmail(\.|$)/.test(p)) out.add("gmail");
  }
  return GOOGLE_PROVIDERS.filter((p) => out.has(p));
}

/** ISO timestamp at which an access token expires (`expires_in` seconds from `now`; default 3600). */
export function expiresAtIso(expiresIn: number | undefined | null, now = Date.now()): string {
  const sec = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
  return new Date(now + sec * 1000).toISOString();
}

export type GoogleTokenResponse = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string };
/** Stored shape (encrypted at rest). Satisfies planner/google.ts, cards/gmail.ts and finance gmailToken. */
export type StoredGoogleToken = { access_token: string; refresh_token?: string; expires_at: string; scope?: string; token_type?: string; connected_at: string };

export function buildGoogleToken(res: GoogleTokenResponse, previous?: Partial<StoredGoogleToken> | null, now = Date.now()): StoredGoogleToken {
  return {
    access_token: res.access_token,
    // Google only returns refresh_token on the first consent; keep the previous one if the new response lacks it.
    refresh_token: res.refresh_token ?? previous?.refresh_token,
    expires_at: expiresAtIso(res.expires_in, now),
    scope: res.scope,
    token_type: res.token_type ?? "Bearer",
    connected_at: new Date(now).toISOString(),
  };
}

export type ProviderStatus = { connected: boolean; connected_at: string | null; scope: string | null; expires_at: string | null; via?: "stored" | "env" };
export type IntegrationsStatus = {
  providers: Record<Provider, ProviderStatus>;
  configured: { google: boolean; oura_env: boolean; freee: boolean };
};

type AnyToken = { connected_at?: string; scope?: string; expires_at?: string | number } | null | undefined;
function shape(t: AnyToken): ProviderStatus {
  if (!t) return { connected: false, connected_at: null, scope: null, expires_at: null };
  const exp = t.expires_at == null ? null : typeof t.expires_at === "number" ? new Date(t.expires_at).toISOString() : t.expires_at;
  return { connected: true, connected_at: t.connected_at ?? null, scope: t.scope ?? null, expires_at: exp, via: "stored" };
}

export function shapeStatus(input: {
  tokens: { google_calendar: AnyToken; gmail: AnyToken; oura: AnyToken; freee: AnyToken };
  env: { googleClientId?: string; ouraAccessToken?: string; freeeClientId?: string };
}): IntegrationsStatus {
  const oura = input.tokens.oura
    ? shape(input.tokens.oura)
    : input.env.ouraAccessToken
      ? { connected: true, connected_at: null, scope: null, expires_at: null, via: "env" as const }
      : shape(null);
  return {
    providers: {
      google_calendar: shape(input.tokens.google_calendar),
      gmail: shape(input.tokens.gmail),
      oura,
      freee: shape(input.tokens.freee),
    },
    configured: { google: Boolean(input.env.googleClientId), oura_env: Boolean(input.env.ouraAccessToken), freee: Boolean(input.env.freeeClientId) },
  };
}
