import { test, expect } from "./helpers";

// Discord is turned off (DISCORD_ENABLED unset): every Discord endpoint answers 404 and the settings page has no Discord card.
test("discord endpoints are off", async ({ authed: page }) => {
  expect((await page.request.post("/api/integrations/discord/interactions", { data: { type: 1 } })).status()).toBe(404);
  expect((await page.request.get("/api/discord/status")).status()).toBe(404);
  expect((await page.request.post("/api/discord/link-code", { headers: { Origin: "http://localhost:5173" } })).status()).toBe(404);
});

test("settings page has no Discord card or toggles", async ({ authed: page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("push-modules")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("discord-card")).toHaveCount(0);
  await expect(page.getByText("Discord")).toHaveCount(0);
});
