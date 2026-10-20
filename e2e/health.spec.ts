import { test, expect } from "./helpers";

const ORIGIN = { Origin: "http://localhost:5173" };
const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

test.beforeEach(async ({ authed: page }) => {
  await page.goto("/health");
  await expect(page.getByRole("heading", { level: 1, name: "健康" })).toBeVisible();
});

test("tabs switch between 体調 / 食事 / 美容 / 検診", async ({ authed: page }) => {
  await expect(page.getByTestId("oura-card")).toBeVisible();
  await page.getByRole("tab", { name: "食事" }).click();
  await expect(page.getByTestId("meal-add")).toBeVisible();
  await page.getByRole("tab", { name: "美容" }).click();
  await expect(page.getByTestId("beauty-add")).toBeVisible();
  await page.getByRole("tab", { name: "検診" }).click();
  await expect(page.getByTestId("checkup-save")).toBeVisible();
  await page.getByRole("tab", { name: "体調" }).click();
  await expect(page.getByTestId("pressure-card")).toBeVisible({ timeout: 30_000 });
});

test("meal routine: add an item without nutrition and totals are marked partial; cost stays 未入力", async ({ authed: page }) => {
  const name = `e2e食品 ${uniq()}`;
  await page.getByRole("tab", { name: "食事" }).click();
  await page.getByTestId("meal-add").click();
  await page.getByTestId("meal-slot").selectOption("lunch");
  await page.getByTestId("meal-name").fill(name);
  await page.getByTestId("meal-save").click();
  await expect(page.getByTestId("meal-item").filter({ hasText: name })).toBeVisible();
  await expect(page.getByTestId("nutrition-partial")).toBeVisible();
  // this item has no cost; the summary must not treat it as 0 → "未入力" count shown
  await expect(page.getByText(/費用未入力 \d+件/)).toBeVisible();

  // API-level: summary reflects partial=true and the item counts
  const res = await page.request.get("/api/health/meals/summary");
  const j = await res.json();
  expect(j.nutrition.partial).toBe(true);
  expect(j.nutrition.item_count).toBeGreaterThan(0);
});

test("checkup: save and see it in history", async ({ authed: page }) => {
  await page.getByRole("tab", { name: "検診" }).click();
  const date = `2020-01-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
  await page.getByTestId("checkup-date").fill(date);
  await page.getByTestId("checkup-ldl").fill("118");
  await page.getByTestId("checkup-hba1c").fill("5.4");
  await page.getByTestId("checkup-save").click();
  const row = page.getByTestId("checkup-row").filter({ hasText: date }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("118");
  await expect(row).toContainText("5.4");
});

test("beauty routine: add and see it listed", async ({ authed: page }) => {
  const name = `e2eケア ${uniq()}`;
  await page.getByRole("tab", { name: "美容" }).click();
  await page.getByTestId("beauty-add").click();
  await page.getByTestId("beauty-name").fill(name);
  await page.getByTestId("beauty-save").click();
  await expect(page.getByTestId("beauty-item").filter({ hasText: name })).toBeVisible();
});

test("pressure: 今しんどい creates a log (weather location set first)", async ({ authed: page }) => {
  const put = await page.request.put("/api/settings/weather_location", { headers: ORIGIN, data: { name: "東京", lat: 35.68, lon: 139.76 } });
  expect(put.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId("pressure-card")).toBeVisible({ timeout: 30_000 });
  const before = await page.getByTestId("pressure-log-item").count();
  await page.getByTestId("pressure-log-now").click();
  await expect(page.getByTestId("pressure-log-item")).toHaveCount(before + 1, { timeout: 20_000 });
  // personal threshold is never claimed without enough data: status text is always present
  await expect(page.getByTestId("personal-status")).toContainText(/個人基準/);

  // edit the newest log's symptom
  await page.getByTestId("pressure-log-item").first().locator("..").getByRole("button", { name: "編集" }).click();
  await page.getByTestId("pressure-log-symptom").fill("頭痛");
  await page.getByTestId("pressure-log-save").click();
  await expect(page.getByTestId("pressure-log-item").first()).toContainText("頭痛");
});

test("health chat: sends a message and receives a reply (fallback allowed)", async ({ authed: page }) => {
  const msg = `今日はどう動く？ ${uniq()}`;
  const input = page.getByLabel("メッセージ");
  await input.fill(msg);
  await page.getByRole("button", { name: "送信" }).click();
  const log = page.getByTestId("chat-log");
  await expect(log).toContainText(msg);
  // the assistant bubble follows the user bubble
  await expect(log.locator(".bg-fill").last()).toBeVisible({ timeout: 30_000 });
  await expect(log.locator(".bg-fill").last()).not.toHaveText("");
  const hist = await page.request.get("/api/health/chat/health");
  const j = await hist.json();
  expect(j.items.some((m: any) => m.role === "assistant")).toBeTruthy();
});
