import { test, expect } from "./helpers";

test("dashboard: clock ticks, suggestion shown, task add from card", async ({ authed: page }) => {
  await expect(page.getByTestId("clock")).toBeVisible();
  await expect(page.getByTestId("suggestion")).not.toBeEmpty();
  const t1 = await page.getByTestId("clock").innerText();
  await page.waitForTimeout(1500);
  expect(await page.getByTestId("clock").innerText()).not.toBe(t1);
  const title = `dash-task-${Date.now()}`;
  await page.getByTestId("dash-task-input").fill(title);
  await page.getByTestId("dash-task-add").click();
  await expect(page.getByTestId("dash-task-list")).toContainText(title);
});

test("settings: display scale changes root CSS variables and persists", async ({ authed: page }) => {
  await page.goto("/settings");
  await page.getByTestId("font-scale").fill("1.2");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-font-scale").trim())).toBe("1.2");
  await page.getByTestId("space-scale").fill("1.1");
  await page.reload();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-space-scale").trim())).toBe("1.1");
  await page.getByRole("button", { name: "標準に戻す" }).click();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-font-scale").trim())).toBe("1");
});

test("settings: theme toggle, notification pref toggle persists, weather location set", async ({ authed: page }) => {
  await page.goto("/settings");
  await page.getByTestId("theme-seg").locator('[data-value="dark"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("theme-seg").locator('[data-value="light"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const row = page.getByTestId("pref-reminder");
  const sw = row.getByRole("switch").nth(1);
  const before = await sw.getAttribute("aria-checked");
  await sw.click();
  await page.reload();
  await expect(page.getByTestId("pref-reminder").getByRole("switch").nth(1)).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");
  await page.getByTestId("geo-input").fill("渋谷");
  await page.getByTestId("geo-search").click();
  await page.getByTestId("geo-result").first().click();
  await expect(page.getByTestId("weather-location")).not.toHaveText("未設定");
  await page.goto("/");
  await expect(page.getByText("天気・気圧")).toBeVisible();
});

test("settings: design theme switches <html data-design> and persists on the server", async ({ authed: page }) => {
  await page.goto("/settings");
  await page.getByTestId("design-material").click();
  await expect(page.locator("html")).toHaveAttribute("data-design", "material");
  await expect(page.getByTestId("design-material")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("design-glass").click();
  await expect(page.locator("html")).toHaveAttribute("data-design", "glass");
  await page.waitForTimeout(300);
  await page.evaluate(() => localStorage.removeItem("lifeos.ui")); // the server copy must bring it back
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-design", "glass");
  await page.getByTestId("design-standard").click();
  await expect(page.locator("html")).toHaveAttribute("data-design", "standard");
});
