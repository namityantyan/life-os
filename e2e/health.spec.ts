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
  await expect(page.getByTestId("pressure-log-item")).toHaveCount(before + 1, { timeout: 30_000 });
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
  const input = page.getByTestId("chat-input");
  await input.fill(msg);
  await page.getByRole("button", { name: "送信" }).click();
  const log = page.getByTestId("chat-log");
  await expect(log).toContainText(msg);
  // the assistant bubble follows the user bubble
  await expect(log.locator(".bg-fill").last()).toBeVisible({ timeout: 30_000 });
  await expect(log.locator(".bg-fill").last()).not.toHaveText("", { timeout: 30_000 });
  const hist = await page.request.get("/api/health/chat/health");
  const j = await hist.json();
  expect(j.items.some((m: any) => m.role === "assistant")).toBeTruthy();
});

test("chat input: Enter adds a newline, Cmd/Ctrl+Enter sends, and the panel keeps a fixed height", async ({ authed: page }) => {
  await page.goto("/health#meal");
  const panel = page.getByTestId("chat-panel");
  await expect(panel).toBeVisible();
  const input = page.getByTestId("chat-input");
  const before = await panel.boundingBox();
  const sentCount = () => page.getByTestId("chat-log").locator(".bg-accent").count();
  const n0 = await sentCount();

  await input.click();
  await input.type("一行目");
  await input.press("Enter");
  await input.type("二行目");
  await expect(input).toHaveValue("一行目\n二行目");
  expect(await sentCount()).toBe(n0); // plain Enter never sends

  // the textarea grows, but the panel does not
  const after = await panel.boundingBox();
  expect(Math.round(after!.height)).toBe(Math.round(before!.height));

  await input.press("ControlOrMeta+Enter");
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("chat-log")).toContainText("二行目");
  await expect.poll(sentCount).toBe(n0 + 1);
  // the log scrolls internally instead of growing the page
  const log = page.getByTestId("chat-log");
  expect(await log.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
});

test("meal chat proposal: review card applies routine changes and targets", async ({ authed: page }) => {
  const H = { Origin: "http://localhost:5173" };
  const name = `提案テスト ${uniq()}`;
  const created = await (await page.request.post("/api/health/meals", { headers: H, data: { slot: "breakfast", food_name: name, amount: 100, unit: "g", nutrition: { energy_kcal: 60, protein_g: 4 }, cost_per_serving: 80 } })).json();
  const id = created.item.id;
  const addName = `追加テスト ${uniq()}`;

  // apply-proposal: add + update (nutrition scales with the amount) + an unresolvable remove
  const res = await page.request.post("/api/health/meals/apply-proposal", { headers: H, data: {
    routines: [
      { op: "add", slot: "lunch", food_name: addName, amount: 115, unit: "g", cost_per_serving: 250, nutrition: { energy_kcal: 120, protein_g: 24 } },
      { op: "update", id, changes: { amount: 200 } },
      { op: "remove", id: "does-not-exist" },
    ],
    targets: { protein_g: 123 },
  } });
  expect(res.ok()).toBeTruthy();
  const r = await res.json();
  expect(r).toMatchObject({ added: 1, updated: 1, removed: 0, targets: true, skipped: 1 });

  const meals = await (await page.request.get("/api/health/meals")).json();
  const updated = meals.items.find((m: any) => m.id === id);
  expect(updated.amount).toBe(200);
  expect(updated.nutrition.energy_kcal).toBe(120); // 60 kcal per 100 g → 200 g
  expect(updated.nutrition_source).toBe("estimated");
  expect(meals.items.some((m: any) => m.food_name === addName && m.slot === "lunch")).toBeTruthy();
  expect(meals.summary.targets.protein_g).toBe(123);

  await page.goto("/health#meal");
  await page.getByRole("tab", { name: "食事" }).click();
  await expect(page.getByTestId("meal-item").filter({ hasText: addName })).toBeVisible({ timeout: 15_000 });

  // cleanup
  for (const m of (await (await page.request.get("/api/health/meals")).json()).items) {
    if (m.food_name === name || m.food_name === addName) await page.request.delete(`/api/health/meals/${m.id}`, { headers: H });
  }
});
