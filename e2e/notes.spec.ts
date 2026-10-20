import { test, expect } from "./helpers";

test("notes: add with category, filter, search, inline edit, archive/unarchive", async ({ authed: page }) => {
  const u = `E2Eメモ${Date.now()}`;
  await page.goto("/notes");
  await expect(page.locator("h1")).toHaveText("メモ");
  await expect(page.getByText("BOTやAIの助言の前提として参照されます")).toBeVisible();

  await page.getByTestId("note-cat-promise").click();
  await page.getByTestId("note-input").fill(`${u} 金曜は早めに帰る`);
  await page.getByTestId("note-add").click();
  const item = page.getByTestId("note-item").filter({ hasText: u });
  await expect(item).toBeVisible();
  await expect(item.getByText("約束")).toBeVisible();

  // category filter
  await page.getByRole("tab", { name: "好み" }).click();
  await expect(item).toHaveCount(0);
  await page.getByRole("tab", { name: "約束" }).click();
  await expect(item).toBeVisible();
  await page.getByRole("tab", { name: "すべて" }).click();

  // search
  await page.getByTestId("note-search").fill(u);
  await expect(page.getByTestId("note-item")).toHaveCount(1);
  await page.getByTestId("note-search").fill(`${u}zzz`);
  await expect(page.getByTestId("note-item")).toHaveCount(0);
  await page.getByTestId("note-search").fill("");

  // inline edit
  await item.getByTestId("note-edit").click();
  await item.getByTestId("note-edit-input").fill(`${u} 金曜は19時までに帰る`);
  await item.getByTestId("note-edit-save").click();
  await expect(page.getByTestId("note-content").filter({ hasText: `${u} 金曜は19時までに帰る` })).toBeVisible();

  // archive → disappears; shows under archived toggle; unarchive
  await item.getByTestId("note-archive").click();
  await expect(page.getByTestId("note-item").filter({ hasText: u })).toHaveCount(0);
  await page.getByTestId("note-archived-toggle").getByRole("switch").click();
  const archived = page.getByTestId("note-item").filter({ hasText: u });
  await expect(archived).toBeVisible();
  await archived.getByTestId("note-unarchive").click();
  await expect(page.getByTestId("note-item").filter({ hasText: u })).toHaveCount(0);
  await page.getByTestId("note-archived-toggle").getByRole("switch").click();
  await expect(page.getByTestId("note-item").filter({ hasText: u })).toBeVisible();
});
