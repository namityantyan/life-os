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
  await expect(page.getByTestId("entry-add")).toBeVisible();
  await page.getByRole("tab", { name: "美容" }).click();
  await expect(page.getByTestId("beauty-add")).toBeVisible();
  await page.getByRole("tab", { name: "検診" }).click();
  await expect(page.getByTestId("checkup-save")).toBeVisible();
  await page.getByRole("tab", { name: "体調" }).click();
  await expect(page.getByTestId("pressure-card")).toBeVisible({ timeout: 30_000 });
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


test("meals: add a set and a saved food with one tap; totals follow", async ({ authed: page }) => {
  const H = { Origin: "http://localhost:5173" };
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: H });

  const foodName = `単品 ${uniq()}`;
  const food = await (await page.request.post("/api/health/meals/foods", { headers: H, data: { name: foodName, amount: 1, unit: "個", nutrition: { energy_kcal: 70, protein_g: 6 }, cost_per_serving: 30 } })).json();
  const set = await (await page.request.post("/api/health/meals/sets", { headers: H, data: { name: `セット ${uniq()}` } })).json();
  await page.request.post(`/api/health/meals/sets/${set.item.id}/items`, { headers: H, data: { food_id: food.item.id } });
  await page.request.post(`/api/health/meals/sets/${set.item.id}/items`, { headers: H, data: { name: "ごはん", amount: 150, unit: "g", nutrition: { energy_kcal: 234 } } });

  await page.goto("/health#meal");
  await page.getByRole("tab", { name: "食事" }).click();
  await expect(page.getByTestId("set-buttons")).toBeVisible();

  // one tap adds every member of the set
  await page.getByTestId(`set-add-${set.item.name}`).click();
  await expect(page.getByTestId("meal-item")).toHaveCount(2, { timeout: 15_000 });

  // one tap adds a single saved food
  await page.getByTestId(`food-add-${foodName}`).click();
  await expect(page.getByTestId("meal-item")).toHaveCount(3, { timeout: 15_000 });

  const log = await (await page.request.get(`/api/health/meals/day?day=${day}`)).json();
  expect(log.entries).toHaveLength(3);
  expect(log.summary.nutrition.totals.energy_kcal).toBe(374); // 70 + 234 + 70
  expect(log.summary.cost.total).toBe(60); // 30 + 30, ごはん has no cost

  // the saved food records how often it was used
  const foods = await (await page.request.get("/api/health/meals/foods")).json();
  expect(foods.items.find((f: any) => f.name === foodName).use_count).toBeGreaterThanOrEqual(1);

  // cleanup
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: H });
  await page.request.delete(`/api/health/meals/sets/${set.item.id}`, { headers: H });
  await page.request.delete(`/api/health/meals/foods/${food.item.id}`, { headers: H });
});

test("meals: servings multiply nutrition and cost; a day can be cleared", async ({ authed: page }) => {
  const H = { Origin: "http://localhost:5173" };
  const day = "2031-03-04"; // a past day of its own, so the test never collides with today's log
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: H });
  const r = await (await page.request.post("/api/health/meals/entries", { headers: H, data: {
    day, food_name: `ゆで卵 ${uniq()}`, amount: 1, unit: "個", nutrition: { energy_kcal: 70, protein_g: 6 }, cost: 30, servings: 2, save_as_food: false,
  } })).json();
  expect(r.item.servings).toBe(2);
  expect(r.item.nutrition.energy_kcal).toBe(140);
  expect(r.item.cost).toBe(60);
  expect(r.summary.nutrition.totals.energy_kcal).toBe(140);

  const cleared = await (await page.request.delete(`/api/health/meals/day/${day}`, { headers: H })).json();
  expect(cleared.entries).toHaveLength(0);
});

test("meal chat proposal: review card applies entries and targets to the day", async ({ authed: page }) => {
  const H = { Origin: "http://localhost:5173" };
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: H });
  const name = `提案 ${uniq()}`;
  const created = await (await page.request.post("/api/health/meals/entries", { headers: H, data: { day, food_name: name, amount: 100, unit: "g", nutrition: { energy_kcal: 60, protein_g: 4 }, cost: 80, save_as_food: false } })).json();
  const id = created.item.id;
  const addName = `追加 ${uniq()}`;

  const res = await page.request.post("/api/health/meals/apply-proposal", { headers: H, data: {
    day,
    entries: [
      { op: "add", food_name: addName, amount: 115, unit: "g", cost: 250, nutrition: { energy_kcal: 120, protein_g: 24 }, save_as_food: true },
      { op: "update", id, changes: { amount: 200 } },
      { op: "remove", id: "does-not-exist" },
    ],
    targets: { protein_g: 123 },
  } });
  expect(res.ok()).toBeTruthy();
  const r = await res.json();
  expect(r).toMatchObject({ added: 1, updated: 1, removed: 0, targets: true, skipped: 1 });

  const updated = r.entries.find((e: any) => e.id === id);
  expect(updated.amount).toBe(200);
  expect(updated.nutrition.energy_kcal).toBe(120); // 60 kcal per 100 g → 200 g
  expect(updated.nutrition_source).toBe("estimated");
  expect(r.entries.some((e: any) => e.food_name === addName)).toBeTruthy();
  expect(r.summary.targets.protein_g).toBe(123);

  // save_as_food also stored it under よく食べるもの
  const foods = await (await page.request.get("/api/health/meals/foods")).json();
  const savedFood = foods.items.find((f: any) => f.name === addName);
  expect(savedFood).toBeTruthy();

  await page.goto("/health#meal");
  await page.getByRole("tab", { name: "食事" }).click();
  await expect(page.getByTestId("meal-item").filter({ hasText: addName })).toBeVisible({ timeout: 15_000 });

  await page.request.delete(`/api/health/meals/day/${day}`, { headers: H });
  await page.request.delete(`/api/health/meals/foods/${savedFood.id}`, { headers: H });
});

test("成分表: typing a food fills nutrition from the table, and grams can be corrected", async ({ authed: page }) => {
  const H = { Origin: "http://localhost:5173" };
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

  // API: lookup and auto-fill without the AI (exact / alias names with grams)
  const lk = await (await page.request.post("/api/health/meals/lookup", { headers: H, data: { name: "ゆで卵", amount: 100, unit: "g" } })).json();
  expect(lk.match).toMatchObject({ number: "12005", grams: 100 });
  expect(lk.match.nutrition.energy_kcal).toBe(134);

  await page.goto("/health#meal");
  await page.getByRole("tab", { name: "食事" }).click();
  await page.getByTestId("entry-add").click();
  await page.getByTestId("entry-name").fill("ごはん");
  await page.getByRole("dialog").getByPlaceholder("150").fill("200");
  await page.getByRole("dialog").getByPlaceholder("g / 個 / 杯").fill("g");
  await expect(page.getByTestId("table-match")).toHaveText("こめ [水稲めし] 精白米 うるち米", { timeout: 15_000 });
  await expect(page.getByTestId("table-lookup")).toContainText("312 kcal");

  // correcting the grams recomputes and syncs the amount
  await page.getByTestId("table-grams").fill("150");
  await page.getByTestId("table-grams").blur();
  await expect(page.getByTestId("table-lookup")).toContainText("234 kcal");
  await expect(page.getByRole("dialog").getByPlaceholder("150")).toHaveValue("150");

  const saveFood = page.getByTestId("entry-save-food");
  if (await saveFood.isChecked()) await saveFood.uncheck();
  await page.getByTestId("entry-save").click();
  const row = page.getByTestId("meal-item").filter({ hasText: "ごはん" }).last();
  await expect(row).toContainText("成分表");
  await expect(row).toContainText("234 kcal");
  await expect(row.getByTestId("entry-ref")).toContainText("精白米 うるち米 150g");

  const log = await (await page.request.get(`/api/health/meals/day?day=${day}`)).json();
  const entry = log.entries.filter((e: any) => e.food_name === "ごはん").pop();
  expect(entry.nutrition_source).toBe("table");
  expect(entry.nutrition_ref).toMatchObject({ number: "01088", grams: 150 });
  await page.request.delete(`/api/health/meals/entries/${entry.id}`, { headers: H });
});
