import { test, expect } from "./helpers";

test("mobile drawer opens from menu button and navigates", async ({ authed: page }) => {
  await page.getByTestId("menu-button").click();
  await expect(page.getByTestId("drawer")).toBeVisible();
  await page.getByTestId("drawer").getByTestId("nav-planner").click();
  await expect(page.getByTestId("drawer")).toHaveCount(0);
  await expect(page.locator("h1").first()).toBeVisible();
  // no horizontal scroll
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBeFalsy();
});
