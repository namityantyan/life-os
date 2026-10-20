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
