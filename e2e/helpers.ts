import { test as base, expect, type Page } from "@playwright/test";

/** Logs in through the dev-login endpoint (DEV_LOGIN=1 in local wrangler vars). */
export async function login(page: Page) {
  await page.goto("/");
  const ctx = page.context();
  await ctx.request.post("/api/auth/dev-login", { headers: { Origin: new URL(page.url()).origin } }); // the server under test (E2E_BASE_URL or :5173)
  await page.goto("/");
  await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 15000 }).catch(async () => {
    // mobile: sidebar hidden; menu button present instead
    await expect(page.getByTestId("menu-button")).toBeVisible();
  });
}

export const test = base.extend<{ authed: Page }>({
  authed: async ({ page }, use) => { await login(page); await use(page); },
});
export { expect };
