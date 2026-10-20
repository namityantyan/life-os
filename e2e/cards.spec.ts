import { test, expect } from "./helpers";

test("cards: set budget, add transaction, totals update, statement add + confirm", async ({ authed: page }) => {
  await page.goto("/cards");
  await page.getByTestId("settings-open").click();
  await page.getByTestId("settings-budget").fill("150000");
  await page.getByTestId("settings-save").click();
  await expect(page.getByText("設定を保存しました")).toBeVisible();
  await expect(page.getByText("予算 150,000円")).toBeVisible();

  const before = await page.request.get("/api/cards/overview").then((r) => r.json()) as { month_total: number };
  const merchant = `E2E店 ${Date.now()}`;
  await page.getByTestId("tx-add").click();
  await page.getByTestId("tx-merchant-input").fill(merchant);
  await page.getByTestId("tx-amount-input").fill("4321");
  await page.getByTestId("tx-submit").click();
  await expect(page.getByText("追加しました")).toBeVisible();
  await expect(page.getByTestId("tx-merchant").filter({ hasText: merchant })).toBeVisible();
  const expected = Math.round(before.month_total + 4321).toLocaleString("ja-JP") + "円";
  await expect(page.getByTestId("card-stats")).toContainText(expected);
  await expect(page.getByTestId("card-stats")).toContainText(Math.round(150000 - before.month_total - 4321).toLocaleString("ja-JP") + "円");
  await expect(page.getByTestId("card-chart")).toBeVisible();

  await page.getByTestId("statement-add").click();
  await page.getByTestId("statement-month").fill("2026-08");
  await page.getByTestId("statement-amount").fill("56789");
  await page.getByTestId("statement-submit").click();
  await expect(page.getByText("明細を登録しました")).toBeVisible();
  const row = page.getByTestId("statement-row").filter({ hasText: "2026-08分" }).first();
  await expect(row).toContainText("56,789円");
  await expect(row).toContainText("確認済み");
});
