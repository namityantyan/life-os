import { test, expect } from "./helpers";

test("ideas: create, organize (fallback ok), edit, status, download, archive", async ({ authed: page }) => {
  const u = `E2Eアイデア${Date.now()}`;
  await page.goto("/ideas");
  await expect(page.locator("h1")).toHaveText("アイデア");

  await page.getByTestId("idea-compose").fill(`${u}\n毎朝10分だけ散歩する。続けやすさを優先。`);
  await page.getByTestId("idea-save").click();
  const card = page.getByTestId("idea-card-title").filter({ hasText: u });
  await expect(card).toBeVisible();

  await card.click();
  await expect(page.getByTestId("idea-modal")).toBeVisible();
  await expect(page.getByTestId("idea-raw")).toContainText(u);

  // organize works with or without the AI binding (fallback keeps the raw text)
  await page.getByTestId("idea-organize").click();
  await expect(page.getByTestId("idea-markdown")).toHaveValue(/^---\ntitle:/, { timeout: 20000 });
  await expect(page.getByTestId("idea-markdown")).toHaveValue(/status: inbox/);
  const md = await page.getByTestId("idea-markdown").inputValue();
  if (await page.getByTestId("idea-ai-offline").isVisible()) expect(md).toContain("毎朝10分だけ散歩する");

  // edit title + status
  await page.getByTestId("idea-title").fill(`${u}-整理後`);
  await page.getByTestId("idea-status").selectOption("next");
  await page.getByTestId("idea-save-edit").click();
  await expect(page.getByTestId("idea-card-title").filter({ hasText: `${u}-整理後` })).toBeVisible();

  // download triggers a .md file named after the title
  const dl = page.waitForEvent("download");
  await page.getByTestId("idea-download").click();
  const download = await dl;
  expect(download.suggestedFilename()).toBe(`${u}-整理後.md`);

  // status filter: visible under 次にやる, hidden under 完了
  await page.getByRole("button", { name: "閉じる" }).first().click();
  await page.getByRole("tab", { name: "次にやる" }).click();
  await expect(page.getByTestId("idea-card-title").filter({ hasText: `${u}-整理後` })).toBeVisible();
  await page.getByRole("tab", { name: "完了" }).click();
  await expect(page.getByTestId("idea-card-title").filter({ hasText: `${u}-整理後` })).toHaveCount(0);
  await page.getByRole("tab", { name: "すべて" }).click();

  // archive, then find it under the archived toggle
  await page.getByTestId("idea-card-title").filter({ hasText: `${u}-整理後` }).click();
  await page.getByTestId("idea-archive").click();
  await expect(page.getByTestId("idea-card-title").filter({ hasText: `${u}-整理後` })).toHaveCount(0);
  await page.getByTestId("idea-archived-toggle").getByRole("switch").click();
  await expect(page.getByTestId("idea-card-title").filter({ hasText: `${u}-整理後` })).toBeVisible();

  // bulk export endpoint returns markdown
  const res = await page.request.get("/api/ideas/export");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["content-type"]).toContain("text/markdown");
});

test("ideas: a failed load shows an error banner, not an empty list", async ({ authed: page }) => {
  await page.route("**/api/ideas?*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal error" }) }));
  await page.goto("/ideas");
  await expect(page.getByTestId("load-error")).toBeVisible();
  await expect(page.getByText("アイデアはまだありません")).toHaveCount(0);
});
