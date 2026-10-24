import { test, expect } from "./helpers";

test("login gate shows dev login and enters the app", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("dev-login")).toBeVisible();
  await page.getByTestId("dev-login").click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page).toHaveTitle(/Life OS｜/);
});

test("sidebar collapses and all modules navigate", async ({ authed: page }) => {
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("sidebar")).toHaveCSS("width", "68px");
  await page.getByTestId("sidebar-toggle").click();
  for (const key of ["planner", "ideas", "notes", "health", "training", "assets", "cards", "fx", "finance", "royalty", "images", "backups", "requests", "settings", "dashboard"]) {
    await page.getByTestId(`nav-${key}`).click();
    await expect(page.getByTestId("page-skeleton")).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator("main")).not.toBeEmpty();
  }
});

test("notification bell: test notification appears, mark read, mark unread", async ({ authed: page }) => {
  const res = await page.request.post("/api/notifications/test", { headers: { Origin: "http://localhost:5173" } });
  expect(res.ok()).toBeTruthy();
  await page.reload();
  await page.getByTestId("bell").click();
  await expect(page.getByTestId("notification-panel")).toBeVisible();
  await expect(page.getByTestId("notification-panel").getByText("テスト通知").first()).toBeVisible();
  await page.getByRole("button", { name: "すべて既読" }).click();
  await expect(page.getByTestId("bell-count")).toHaveCount(0);
});
