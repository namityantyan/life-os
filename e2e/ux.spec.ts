import { test, expect } from "./helpers";

test("command palette: ⌘K opens, 筋トレ + Enter navigates to /training", async ({ authed: page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await page.getByTestId("palette-input").fill("筋トレ");
  await expect(page.getByTestId("palette-item-mod-training")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/training/);
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  // Esc closes; search button opens; aliases: 予定 → スケジュール, fx → FXシグナル
  await page.getByTestId("palette-button").click();
  await page.getByTestId("palette-input").fill("予定");
  await expect(page.getByTestId("palette-item-mod-planner")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("palette-input").fill("fx");
  await expect(page.getByTestId("palette-item-mod-fx")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
});

test("command palette: quick action adds a task that appears on the dashboard", async ({ authed: page }) => {
  const title = `ux-task-${Date.now()}`;
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("palette-input").fill(title);
  await expect(page.getByTestId("palette-item-task")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(page.getByTestId("dash-task-list")).toContainText(title, { timeout: 10000 });
  // keyboard navigation: ↓ moves selection
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await expect(page.getByTestId("palette-item-mod-dashboard")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("palette-item-mod-planner")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
});

test("data export/stats/import endpoints", async ({ authed: page }) => {
  const headers = { Origin: "http://localhost:5173" };
  const exp = await page.request.get("/api/data/export");
  expect(exp.ok()).toBeTruthy();
  const json = await exp.json();
  expect(typeof json.exported_at).toBe("string");
  expect(json.version).toBe(1);
  expect(Array.isArray(json.tables.planner_items)).toBeTruthy();
  expect(Array.isArray(json.tables.notes)).toBeTruthy();
  expect(json.tables.integration_tokens).toBeUndefined();

  const stats = await (await page.request.get("/api/data/stats")).json();
  expect(stats.counts.planner_items).toBeGreaterThanOrEqual(0);
  expect(stats.tables).toContain("notes");

  // merge import is idempotent by primary key; unknown tables are skipped; replace needs a mode
  const id = `ux-import-${Date.now()}`;
  const body = { mode: "merge", data: { tables: { notes: [{ id, category: "other", content: `imported ${id}`, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }], bogus: [{ x: 1 }] } } };
  const r1 = await (await page.request.post("/api/data/import", { headers, data: body })).json();
  expect(r1.inserted.notes).toBe(1);
  expect(r1.skipped).toContain("bogus");
  const r2 = await (await page.request.post("/api/data/import", { headers, data: body })).json();
  expect(r2.inserted.notes).toBe(0);
  const bad = await page.request.post("/api/data/import", { headers, data: { mode: "wipe", data: {} } });
  expect(bad.status()).toBe(400);
  const md = await page.request.get("/api/data/export/notes.md");
  expect(md.headers()["content-type"]).toContain("text/markdown");
  expect(await md.text()).toContain(`imported ${id}`);
});

test("settings data card shows counts and import preview", async ({ authed: page }) => {
  await page.goto("/settings#data");
  await expect(page.getByTestId("data-counts")).toBeVisible();
  await expect(page.getByTestId("data-total")).toContainText("件");
  await page.getByTestId("import-file").setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ version: 1, tables: { notes: [{ id: "preview-only", category: "other", content: "p" }] } })) });
  await expect(page.getByTestId("import-preview")).toContainText("メモ");
  await page.getByTestId("import-mode").locator('[data-value="replace"]').click();
  await expect(page.getByTestId("import-confirm")).toBeDisabled();
  await page.getByTestId("import-confirm-text").fill("置き換え");
  await expect(page.getByTestId("import-confirm")).toBeEnabled();
  await page.getByRole("button", { name: "キャンセル" }).click();
});

test("error boundary catches a throwing page and recovers to the dashboard", async ({ authed: page }) => {
  await page.goto("/__error");
  await expect(page.getByTestId("error-boundary")).toBeVisible();
  await expect(page.getByText("この画面でエラーが発生しました")).toBeVisible();
  await expect(page.getByTestId("error-message")).toContainText("テスト用のエラー");
  // the shell is intact
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await page.getByTestId("error-home").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("clock")).toBeVisible();
});
