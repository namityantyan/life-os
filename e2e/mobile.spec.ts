import { test, expect } from "./helpers";

test("mobile drawer opens from menu button and navigates", async ({ authed: page }) => {
  await page.getByTestId("menu-button").click();
  await expect(page.getByTestId("drawer")).toBeVisible();
  await page.getByTestId("drawer").getByTestId("nav-planner").click();
  await expect(page.getByTestId("drawer")).toHaveCount(0);
  await expect(page.locator("h1").first()).toBeVisible();
  await page.getByTestId("menu-button").click();
  await page.getByTestId("drawer").getByTestId("nav-dashboard").click();
  await expect(page.getByTestId("clock")).toBeVisible();
  // no horizontal scroll
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBeFalsy();
});

test("mobile bottom tab bar navigates and shows the active indicator", async ({ authed: page }) => {
  await expect(page.getByTestId("tabbar")).toBeVisible();
  await expect(page.getByTestId("tab-dashboard").getByTestId("tab-indicator")).toBeVisible();
  await page.getByTestId("tab-health").click();
  await expect(page).toHaveURL(/\/health/);
  await expect(page.getByTestId("tab-health").getByTestId("tab-indicator")).toBeVisible();
  await expect(page.getByTestId("tab-dashboard").getByTestId("tab-indicator")).toHaveCount(0);
  await page.getByTestId("tab-training").click();
  await expect(page).toHaveURL(/\/training/);
  // palette via header button works on mobile too
  await page.getByTestId("palette-button").click();
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("palette-item-mod-cards").click();
  await expect(page).toHaveURL(/\/cards/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBeFalsy();
});

test("mobile tab bar: その他 opens the drawer; bar contents follow 設定 and persist on the server", async ({ authed: page }) => {
  await page.getByTestId("tab-more").click();
  await expect(page.getByTestId("drawer")).toBeVisible();
  await page.getByTestId("drawer-close").click();
  await expect(page.getByTestId("drawer")).toHaveCount(0);
  await page.goto("/settings#tabbar");
  await page.getByTestId("tabbar-reset").click();
  await page.getByTestId("tabbar-remove-cards").click();
  await page.getByTestId("tabbar-add-notes").click();
  await page.getByTestId("tabbar-up-notes").click();
  await expect(page.getByTestId("tab-cards")).toHaveCount(0);
  await page.waitForTimeout(700); // debounced save
  await page.evaluate(() => localStorage.removeItem("lifeos.tabbar")); // the server copy must bring it back
  await page.reload();
  await expect(page.getByTestId("tab-notes")).toBeVisible();
  const order = await page.getByTestId("tabbar").locator("a[data-testid^='tab-']").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order).toEqual(["tab-dashboard", "tab-planner", "tab-health", "tab-notes", "tab-training"]);
  await page.getByTestId("tabbar-reset").click();
  await page.waitForTimeout(700);
});
