import { test, expect } from "./helpers";

const ORIGIN = { Origin: "http://localhost:5173" };

test("integrations: status endpoint reports every provider disconnected locally", async ({ authed: page }) => {
  const res = await page.request.get("/api/integrations/status");
  expect(res.status()).toBe(200);
  const j = await res.json();
  for (const p of ["google_calendar", "gmail", "oura", "freee"]) {
    expect(j.providers[p].connected, p).toBe(false);
    expect(j.providers[p].connected_at, p).toBeNull();
  }
  // GOOGLE_CLIENT_ID is absent in local .dev.vars
  expect(j.configured.google).toBe(false);
});

test("integrations: google/start is refused when GOOGLE_CLIENT_ID is not configured", async ({ authed: page }) => {
  const res = await page.request.get("/api/integrations/google/start?scopes=calendar", { maxRedirects: 0 });
  expect(res.status()).toBe(503);
});

test("integrations: bogus Oura token is rejected by the API and the card shows the error", async ({ authed: page }) => {
  const api = await page.request.post("/api/integrations/oura", { headers: ORIGIN, data: { token: "bogus-token-for-e2e-0000" } });
  expect(api.status()).toBeGreaterThanOrEqual(400);
  expect(api.status()).toBeLessThan(500);
  expect((await api.json()).error).toBeTruthy();
  const short = await page.request.post("/api/integrations/oura", { headers: ORIGIN, data: { token: "x" } });
  expect(short.status()).toBe(400);

  await page.goto("/settings#integrations");
  const oura = page.getByTestId("integration-oura");
  await expect(oura).toBeVisible();
  await expect(oura.getByTestId("oura-connect")).toBeDisabled();
  await oura.getByTestId("oura-token").fill("bogus-token-for-e2e-0000");
  await oura.getByTestId("oura-connect").click();
  await expect(oura.getByTestId("oura-error")).toBeVisible();
  await expect(oura.getByTestId("oura-error")).not.toBeEmpty();
  // still disconnected
  const after = await (await page.request.get("/api/integrations/status")).json();
  expect(after.providers.oura.connected).toBe(false);
});

test("integrations: card renders Google and Oura; Google connect is disabled with the unconfigured note", async ({ authed: page }) => {
  await page.goto("/settings#integrations");
  const card = page.getByTestId("integrations-card");
  await expect(card).toBeVisible();
  const google = card.getByTestId("integration-google");
  await expect(google).toContainText("Google（カレンダー・Gmail）");
  await expect(google).toContainText("未接続");
  await expect(google.getByTestId("google-scope-calendar")).toBeChecked();
  await expect(google.getByTestId("google-scope-gmail")).toBeChecked();
  await expect(google.getByTestId("google-connect")).toBeDisabled();
  await expect(google.getByTestId("google-unconfigured")).toContainText("GOOGLE_CLIENT_ID");

  const oura = card.getByTestId("integration-oura");
  await expect(oura).toContainText("Oura");
  await expect(oura.getByTestId("oura-token")).toBeVisible();

  const freee = card.getByTestId("integration-freee");
  await expect(freee.getByTestId("freee-link")).toHaveAttribute("href", "/assets?tab=accounts");
});

test("integrations: ?connected=google shows a toast and is removed from the URL", async ({ authed: page }) => {
  await page.goto("/settings?connected=google");
  await expect(page.getByRole("status").filter({ hasText: "Googleと接続しました" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("connected")).toBeNull();
});
