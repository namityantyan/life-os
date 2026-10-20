import { describe, it, expect } from "vitest";
import { buildGoogleToken, expiresAtIso, GOOGLE_SCOPES, parseRequestedScopes, providersForGrantedScopes, scopeParam, shapeStatus } from "../../worker/modules/integrations/logic";

describe("requested scopes", () => {
  it("parses ?scopes=calendar,gmail, dedupes, ignores unknown, defaults to both", () => {
    expect(parseRequestedScopes("calendar,gmail")).toEqual(["calendar", "gmail"]);
    expect(parseRequestedScopes("gmail, gmail ,foo")).toEqual(["gmail"]);
    expect(parseRequestedScopes("")).toEqual(["calendar", "gmail"]);
    expect(parseRequestedScopes(undefined)).toEqual(["calendar", "gmail"]);
    expect(parseRequestedScopes("bogus")).toEqual(["calendar", "gmail"]);
  });
  it("builds the read-only scope string", () => {
    expect(scopeParam(["calendar"])).toBe(GOOGLE_SCOPES.calendar);
    expect(scopeParam(["calendar", "gmail"])).toBe(`${GOOGLE_SCOPES.calendar} ${GOOGLE_SCOPES.gmail}`);
    expect(GOOGLE_SCOPES.calendar).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(GOOGLE_SCOPES.gmail).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });
});

describe("granted scope → providers", () => {
  it("maps calendar/gmail readonly scopes to their providers (order stable)", () => {
    expect(providersForGrantedScopes("https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly openid")).toEqual(["google_calendar", "gmail"]);
    expect(providersForGrantedScopes("https://www.googleapis.com/auth/calendar.readonly")).toEqual(["google_calendar"]);
    expect(providersForGrantedScopes("https://www.googleapis.com/auth/gmail.readonly")).toEqual(["gmail"]);
  });
  it("accepts broader calendar/gmail scopes but nothing else", () => {
    expect(providersForGrantedScopes("https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify")).toEqual(["google_calendar", "gmail"]);
    expect(providersForGrantedScopes("openid email profile")).toEqual([]);
    expect(providersForGrantedScopes("https://www.googleapis.com/auth/calendarfoo")).toEqual([]);
    expect(providersForGrantedScopes(undefined)).toEqual([]);
  });
});

describe("expires_at", () => {
  const now = Date.parse("2026-10-21T00:00:00Z");
  it("is ISO and equals now + expires_in seconds", () => {
    expect(expiresAtIso(3599, now)).toBe("2026-10-21T00:59:59.000Z");
  });
  it("falls back to one hour when expires_in is missing or invalid", () => {
    expect(expiresAtIso(undefined, now)).toBe("2026-10-21T01:00:00.000Z");
    expect(expiresAtIso(0, now)).toBe("2026-10-21T01:00:00.000Z");
    expect(expiresAtIso(Number.NaN, now)).toBe("2026-10-21T01:00:00.000Z");
  });
  it("buildGoogleToken stores ISO expires_at/connected_at and keeps a previous refresh_token", () => {
    const t = buildGoogleToken({ access_token: "a", expires_in: 60, scope: "s" }, { refresh_token: "old" }, now);
    expect(t).toEqual({ access_token: "a", refresh_token: "old", expires_at: "2026-10-21T00:01:00.000Z", scope: "s", token_type: "Bearer", connected_at: "2026-10-21T00:00:00.000Z" });
    expect(buildGoogleToken({ access_token: "a", refresh_token: "new" }, { refresh_token: "old" }, now).refresh_token).toBe("new");
    expect(buildGoogleToken({ access_token: "a" }, null, now).refresh_token).toBeUndefined();
  });
});

describe("status shaping", () => {
  it("reports every provider disconnected and env flags false when nothing is set", () => {
    const s = shapeStatus({ tokens: { google_calendar: null, gmail: null, oura: null, freee: null }, env: {} });
    for (const p of ["google_calendar", "gmail", "oura", "freee"] as const) expect(s.providers[p]).toEqual({ connected: false, connected_at: null, scope: null, expires_at: null });
    expect(s.configured).toEqual({ google: false, oura_env: false, freee: false });
  });
  it("exposes connected_at/scope/expires_at from stored tokens and normalizes ms expires_at to ISO", () => {
    const s = shapeStatus({
      tokens: {
        google_calendar: { connected_at: "2026-10-21T00:00:00.000Z", scope: "cal", expires_at: "2026-10-21T01:00:00.000Z" },
        gmail: { connected_at: "2026-10-21T00:00:00.000Z", scope: "gm", expires_at: Date.parse("2026-10-21T02:00:00Z") },
        oura: { connected_at: "2026-10-20T00:00:00.000Z" },
        freee: null,
      },
      env: { googleClientId: "id", freeeClientId: "f" },
    });
    expect(s.providers.google_calendar).toEqual({ connected: true, connected_at: "2026-10-21T00:00:00.000Z", scope: "cal", expires_at: "2026-10-21T01:00:00.000Z", via: "stored" });
    expect(s.providers.gmail.expires_at).toBe("2026-10-21T02:00:00.000Z");
    expect(s.providers.oura).toEqual({ connected: true, connected_at: "2026-10-20T00:00:00.000Z", scope: null, expires_at: null, via: "stored" });
    expect(s.providers.freee.connected).toBe(false);
    expect(s.configured).toEqual({ google: true, oura_env: false, freee: true });
  });
  it("treats OURA_ACCESS_TOKEN in env as connected via env, but a stored token wins", () => {
    const env = shapeStatus({ tokens: { google_calendar: null, gmail: null, oura: null, freee: null }, env: { ouraAccessToken: "x" } });
    expect(env.providers.oura).toEqual({ connected: true, connected_at: null, scope: null, expires_at: null, via: "env" });
    expect(env.configured.oura_env).toBe(true);
    const both = shapeStatus({ tokens: { google_calendar: null, gmail: null, oura: { connected_at: "2026-10-20T00:00:00.000Z" }, freee: null }, env: { ouraAccessToken: "x" } });
    expect(both.providers.oura.via).toBe("stored");
  });
});
