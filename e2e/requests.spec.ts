import { test, expect } from "./helpers";

test("requests: create, edit, change status from card, filter, search, delete", async ({ authed: page }) => {
  const u = `E2E要望${Date.now()}`;
  await page.goto("/requests");
  await expect(page.locator("h1")).toHaveText("リクエスト");

  await page.getByTestId("request-add").click();
  await expect(page.getByTestId("request-modal")).toBeVisible();
  await page.getByTestId("request-title").fill(u);
  await page.getByTestId("request-detail").fill("カード利用の月次グラフがほしい");
  await page.getByTestId("request-example").fill("棒グラフで12か月分");
  await page.getByTestId("request-save").click();
  const card = page.getByTestId("request-card").filter({ hasText: u });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("request-open").getByText("未対応")).toBeVisible();

  // edit via modal
  await card.getByTestId("request-open").click();
  await page.getByTestId("request-title").fill(`${u}-改`);
  await page.getByTestId("request-save").click();
  const card2 = page.getByTestId("request-card").filter({ hasText: `${u}-改` });
  await expect(card2).toBeVisible();

  // status change from the card
  await card2.getByTestId("request-status").selectOption("in_progress");
  await expect(card2.getByTestId("request-open").getByText("対応中")).toBeVisible();

  // status filter
  await page.getByRole("tab", { name: "完了" }).click();
  await expect(page.getByTestId("request-card").filter({ hasText: `${u}-改` })).toHaveCount(0);
  await page.getByRole("tab", { name: "対応中" }).click();
  await expect(page.getByTestId("request-card").filter({ hasText: `${u}-改` })).toBeVisible();
  await page.getByRole("tab", { name: "すべて" }).click();

  // search by detail text
  await page.getByTestId("request-search").fill("月次グラフがほしい");
  await expect(page.getByTestId("request-card").filter({ hasText: `${u}-改` })).toBeVisible();
  await page.getByTestId("request-search").fill(`${u}zzz`);
  await expect(page.getByTestId("request-card")).toHaveCount(0);
  await page.getByTestId("request-search").fill("");

  // delete
  await page.getByTestId("request-card").filter({ hasText: `${u}-改` }).getByTestId("request-open").click();
  await page.getByTestId("request-delete").click();
  await expect(page.getByTestId("request-card").filter({ hasText: `${u}-改` })).toHaveCount(0);
});
