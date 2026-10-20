import { test, expect } from "./helpers";

test("assets: create account, enter balance, see overview total", async ({ authed: page }) => {
  const name = `E2E銀行 ${Date.now()}`;
  await page.goto("/assets?tab=accounts");
  await page.getByTestId("account-add").click();
  await page.getByTestId("account-name-input").fill(name);
  await page.getByTestId("account-category").selectOption("bank");
  await page.getByTestId("account-submit").click();
  await expect(page.getByTestId("account-name").filter({ hasText: name })).toBeVisible();

  await page.goto("/assets?tab=entry");
  const qty = page.getByTestId(`qty-${name}`);
  await expect(qty).toBeVisible();
  await qty.fill("1234567");
  await page.getByTestId("entry-save").click();
  await expect(page.getByText(/件を保存しました/)).toBeVisible();

  await page.goto("/assets?tab=overview");
  await expect(page.getByText("総資産（負債を除く）")).toBeVisible();
  const row = page.locator(".card").filter({ hasText: name }).first();
  await expect(row).toContainText("1,234,567円");
  await expect(page.getByTestId("asset-chart")).toBeVisible();
});

test("assets: plan → allocation shows a value or an undetermined reason", async ({ authed: page }) => {
  await page.goto("/assets?tab=allocate");
  await page.getByTestId("plan-living").fill("200000");
  await page.getByTestId("plan-reserve").fill("100000");
  await page.getByTestId("plan-save").click();
  await expect(page.getByText("計画を保存しました")).toBeVisible();
  const result = page.getByTestId("allocation-result");
  const undet = page.getByTestId("allocation-undetermined");
  await expect(result.or(undet)).toBeVisible();
  if (await result.isVisible()) {
    await expect(result).toContainText("守る額");
    await expect(result).toContainText("運用に回す額");
  } else {
    await expect(undet).toContainText("判断を保留");
    await expect(undet.locator(".text-orange")).not.toBeEmpty();
  }
});

test("assets: partial account update keeps owner/currency/source (API)", async ({ authed: page }) => {
  const H = { Origin: "http://localhost:5173" };
  const created = await (await page.request.post("/api/assets/accounts", { headers: H, data: { name: `E2E USD ${Date.now()}`, category: "bank", currency: "usd", owner_type: "corporate", owner: "法人X", unit: "USD" } })).json();
  expect(created).toMatchObject({ owner: "法人X", owner_type: "corporate", currency: "USD" });
  const updated = await (await page.request.put(`/api/assets/accounts/${created.id}`, { headers: H, data: { name: created.name + " 改" } })).json();
  expect(updated).toMatchObject({ name: created.name + " 改", owner: "法人X", owner_type: "corporate", currency: "USD", source: "manual", unit: "USD" });
  await page.request.delete(`/api/assets/accounts/${created.id}`, { headers: H });
});
