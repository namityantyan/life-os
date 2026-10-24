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


/* ------------------------------------------------------------------ meals */
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const openMeals = async (page: import("@playwright/test").Page) => {
  await page.goto("/health#meal");
  await page.getByRole("tab", { name: "食事" }).click(); // a hash-only change does not switch the tab
  await expect(page.getByTestId("quick-add-input")).toBeVisible({ timeout: 15_000 });
};
const row = (page: import("@playwright/test").Page, text: string) => page.getByTestId("meal-item").filter({ hasText: text });

test("meals: add a set and a saved food with one tap; totals follow", async ({ authed: page }) => {
  const day = today();
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN });
  const foodName = `単品 ${uniq()}`;
  // Earlier runs leave saved foods behind; only the first 16 show as chips, so archive old test foods.
  for (const f of (await (await page.request.get("/api/health/meals/foods")).json()).items ?? []) if (/^(単品|ゆで卵|追加) /.test(f.name)) await page.request.put(`/api/health/meals/foods/${f.id}`, { headers: ORIGIN, data: { archived: true } });
  const food = await (await page.request.post("/api/health/meals/foods", { headers: ORIGIN, data: { name: foodName, amount: 1, unit: "個", nutrition: { energy_kcal: 70, protein_g: 6 }, cost_per_serving: 30 } })).json();
  const set = await (await page.request.post("/api/health/meals/sets", { headers: ORIGIN, data: { name: `セット ${uniq()}` } })).json();
  await page.request.post(`/api/health/meals/sets/${set.item.id}/items`, { headers: ORIGIN, data: { food_id: food.item.id } });
  await page.request.post(`/api/health/meals/sets/${set.item.id}/items`, { headers: ORIGIN, data: { name: "ごはん", amount: 150, unit: "g", nutrition: { energy_kcal: 234 } } });

  await openMeals(page);
  await page.getByTestId(`set-add-${set.item.name}`).click();
  await expect(page.getByTestId("meal-item")).toHaveCount(2, { timeout: 15_000 });
  await page.getByTestId(`food-add-${foodName}`).click();
  await expect(page.getByTestId("meal-item")).toHaveCount(3, { timeout: 15_000 });
  // the summary follows at once (optimistic) and matches the server
  await expect(page.getByTestId("energy-total")).toHaveText("374");
  await expect(page.getByTestId("meal-cost-total")).toHaveText("60円");

  await expect.poll(async () => (await (await page.request.get(`/api/health/meals/day?day=${day}`)).json()).entries.length).toBe(3);
  const log = await (await page.request.get(`/api/health/meals/day?day=${day}`)).json();
  expect(log.summary.nutrition.totals.energy_kcal).toBe(374); // 70 + 234 + 70
  expect(log.summary.cost.total).toBe(60); // ごはん has no cost: missing, not free
  const foods = await (await page.request.get("/api/health/meals/foods")).json();
  expect(foods.items.find((f: any) => f.name === foodName).use_count).toBeGreaterThanOrEqual(1);

  await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN });
  await page.request.delete(`/api/health/meals/sets/${set.item.id}`, { headers: ORIGIN });
  await page.request.delete(`/api/health/meals/foods/${food.item.id}`, { headers: ORIGIN });
});

test("meals API: servings multiply nutrition and cost; edits rescale; a day can be cleared", async ({ authed: page }) => {
  const day = "2031-03-04"; // a day of its own, so the test never collides with today's log
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN });
  const r = await (await page.request.post("/api/health/meals/entries", { headers: ORIGIN, data: {
    day, food_name: `ゆで卵 ${uniq()}`, amount: 1, unit: "個", nutrition: { energy_kcal: 70, protein_g: 6 }, cost: 30, servings: 2, save_as_food: false,
  } })).json();
  expect(r.item).toMatchObject({ servings: 2, cost: 60, nutrition: { energy_kcal: 140 } });
  expect(r.summary.nutrition.totals.energy_kcal).toBe(140);
  // three servings: per-serving values × 3, cost too
  const u = await (await page.request.put(`/api/health/meals/entries/${r.item.id}`, { headers: ORIGIN, data: { servings: 3 } })).json();
  expect(u.item).toMatchObject({ servings: 3, cost: 90, nutrition: { energy_kcal: 210, protein_g: 18 }, nutrition_source: "recorded" });
  // a 成分表 food chosen explicitly is computed on the server (never trusted from the client)
  const t = await (await page.request.put(`/api/health/meals/entries/${r.item.id}`, { headers: ORIGIN, data: { servings: 1, table: { number: "12005", grams: 50 }, nutrition: { energy_kcal: 9999 } } })).json();
  expect(t.item).toMatchObject({ nutrition_source: "table", nutrition_ref: { number: "12005", grams: 50 }, nutrition: { energy_kcal: 67 } });
  // a new name without values is stored at once and reports that it still needs a lookup
  const n = await (await page.request.post("/api/health/meals/entries", { headers: ORIGIN, data: { day, food_name: "ごはん", amount: 150, unit: "g" } })).json();
  expect(n.needs_lookup).toBe(true);
  expect(n.item.nutrition).toBeNull();
  const filled = await (await page.request.post(`/api/health/meals/entry/${n.item.id}/table`, { headers: ORIGIN, data: { auto: true } })).json();
  expect(filled).toMatchObject({ applied: true, item: { nutrition_source: "table", nutrition: { energy_kcal: 234 } } });
  // auto never overwrites values typed by hand
  expect((await (await page.request.post(`/api/health/meals/entry/${r.item.id}/table`, { headers: ORIGIN, data: { auto: true } })).json()).applied).toBe(false);

  const cleared = await (await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN })).json();
  expect(cleared.entries).toHaveLength(0);
});

test("meal chat proposal: review card applies entries and targets to the day", async ({ authed: page }) => {
  const day = today();
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN });
  const before = (await (await page.request.get("/api/health/targets")).json()).targets;
  const name = `提案 ${uniq()}`;
  const created = await (await page.request.post("/api/health/meals/entries", { headers: ORIGIN, data: { day, food_name: name, amount: 100, unit: "g", nutrition: { energy_kcal: 60, protein_g: 4 }, cost: 80, save_as_food: false } })).json();
  const id = created.item.id;
  const addName = `追加 ${uniq()}`;
  const r = await (await page.request.post("/api/health/meals/apply-proposal", { headers: ORIGIN, data: {
    day,
    entries: [
      { op: "add", food_name: addName, amount: 115, unit: "g", cost: 250, nutrition: { energy_kcal: 120, protein_g: 24 }, save_as_food: true },
      { op: "update", id, changes: { amount: 200 } },
      { op: "remove", id: "does-not-exist" },
    ],
    targets: { protein_g: 123 },
  } })).json();
  expect(r).toMatchObject({ added: 1, updated: 1, removed: 0, targets: true, skipped: 1 });
  expect(r.pending_ids).toHaveLength(1); // the client fills it from the 成分表 afterwards
  const updated = r.entries.find((e: any) => e.id === id);
  expect(updated).toMatchObject({ amount: 200, nutrition: { energy_kcal: 120 }, nutrition_source: "estimated" });
  expect(r.entries.find((e: any) => e.food_name === addName)).toMatchObject({ nutrition_source: "estimated", nutrition: { energy_kcal: 120 } });
  expect(r.summary.targets.protein_g).toBe(123);
  const foods = await (await page.request.get("/api/health/meals/foods")).json();
  const savedFood = foods.items.find((f: any) => f.name === addName);
  expect(savedFood).toBeTruthy();

  await openMeals(page);
  await expect(row(page, addName)).toBeVisible({ timeout: 15_000 });

  await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN });
  await page.request.delete(`/api/health/meals/foods/${savedFood.id}`, { headers: ORIGIN });
  await page.request.put("/api/health/targets", { headers: ORIGIN, data: before });
});

test("成分表: quick add fills nutrition from the table; the sheet corrects grams and the matched food", async ({ authed: page }) => {
  const day = today();
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN });
  const lk = await (await page.request.post("/api/health/meals/lookup", { headers: ORIGIN, data: { name: "ゆで卵", amount: 100, unit: "g" } })).json();
  expect(lk.match).toMatchObject({ number: "12005", grams: 100 });
  expect(lk.candidates[0].per100g.energy_kcal).toBeGreaterThan(0);

  await openMeals(page);
  await page.getByTestId("quick-add-input").fill("ごはん 200g");
  await page.getByTestId("quick-add-input").press("Enter");
  await expect(page.getByTestId("quick-add-input")).toHaveValue(""); // cleared at once, the row is already there
  const rice = row(page, "ごはん");
  await expect(rice).toContainText("312", { timeout: 15_000 });
  await expect(rice).toContainText("成分表");

  // correct the grams: the amount follows (g), the preview and the row update
  await rice.click();
  await expect(page.getByTestId("table-match")).toHaveText("こめ [水稲めし] 精白米 うるち米");
  await page.getByTestId("table-grams").fill("150");
  await expect(page.getByTestId("nutrition-preview")).toContainText("234 kcal");
  await expect(page.getByTestId("entry-amount")).toHaveValue("150");
  await page.getByTestId("entry-save").click();
  await expect(page.getByTestId("item-sheet")).toBeHidden();
  await expect(rice).toContainText("234");
  await expect(rice.getByTestId("entry-ref")).toContainText("精白米 うるち米 150g");

  // ナッツ: a plain form is picked, and another table food can be chosen from the candidates
  await page.getByTestId("quick-add-input").fill("ナッツ 25g");
  await page.getByTestId("quick-add-input").press("Enter");
  const nuts = row(page, "ナッツ");
  await expect(nuts.getByTestId("entry-ref")).toContainText("アーモンド いり 無塩 25g", { timeout: 15_000 });
  await nuts.click();
  await page.getByTestId("table-candidate").filter({ hasText: "くるみ いり" }).click();
  await expect(page.getByTestId("table-match")).toHaveText("くるみ いり");
  await page.getByTestId("entry-save").click();
  await expect(nuts.getByTestId("entry-ref")).toContainText("くるみ いり 25g");

  const log = await (await page.request.get(`/api/health/meals/day?day=${day}`)).json();
  expect(log.entries.find((e: any) => e.food_name === "ごはん")).toMatchObject({ nutrition_source: "table", nutrition_ref: { number: "01088", grams: 150 }, amount: 150 });
  expect(log.entries.find((e: any) => e.food_name === "ナッツ")).toMatchObject({ nutrition_ref: { number: "05014", grams: 25 } });
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN });
});

test("meals: manual values (energy from P/F/C, vitamin D in IU), servings, delete with undo", async ({ authed: page }) => {
  const day = today();
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN });
  const name = `ラベル ${uniq()}`;
  await openMeals(page);
  await page.getByTestId("quick-add-input").fill(`${name} 1袋`);
  await page.getByTestId("quick-add-input").press("Enter");
  const r = row(page, name);
  await expect(r).toBeVisible();
  await r.click();
  await page.getByTestId("nutrition-mode").getByRole("tab", { name: "手入力" }).click();
  await page.getByTestId("nutrient-protein_g").fill("20");
  await page.getByTestId("nutrient-fat_g").fill("10");
  await page.getByTestId("nutrient-carbs_g").fill("30");
  await expect(page.getByTestId("nutrient-energy_kcal")).toHaveValue("290"); // 4·9·4, read-only
  await page.getByRole("button", { name: "ミネラル・ビタミン" }).click();
  await page.getByTestId("nutrient-vitamin_d_ug").fill("400"); // IU
  await page.getByRole("button", { name: "0.5回分ふやす" }).click();
  await page.getByRole("button", { name: "0.5回分ふやす" }).click();
  await page.getByTestId("entry-cost").fill("150");
  await page.getByTestId("entry-save").click();
  await expect(r).toContainText("580"); // 290 × 2
  await expect(r).toContainText("記録");

  await expect.poll(async () => (await (await page.request.get(`/api/health/meals/day?day=${day}`)).json()).entries.find((e: any) => e.food_name === name)?.servings).toBe(2);
  const e = (await (await page.request.get(`/api/health/meals/day?day=${day}`)).json()).entries.find((x: any) => x.food_name === name);
  expect(e).toMatchObject({ nutrition_source: "recorded", cost: 300, nutrition: { energy_kcal: 580, protein_g: 40, vitamin_d_ug: 20 } }); // 400 IU = 10 µg, × 2

  // delete → undo → delete for good
  await r.click();
  await page.getByTestId("entry-delete").click();
  await expect(r).toHaveCount(0);
  await page.getByTestId("undo-delete").click();
  await expect(r).toHaveCount(1);
  await r.click();
  await page.getByTestId("entry-delete").click();
  await expect(r).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get(`/api/health/meals/day?day=${day}`)).json()).entries.length, { timeout: 10_000 }).toBe(0);
});

test("meals: targets from the reference values; day navigation; a day saved as a set", async ({ authed: page }) => {
  const before = (await (await page.request.get("/api/health/targets")).json()).targets;
  const day = today();
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN });
  await page.request.post("/api/health/meals/entries", { headers: ORIGIN, data: { day, food_name: "ごはん", amount: 150, unit: "g", table: { number: "01088", grams: 150 } } });
  await openMeals(page);

  await page.getByTestId("targets-edit").click();
  await page.getByTestId("targets-preset-female").click();
  await expect(page.getByTestId("nutrient-energy_kcal")).toHaveValue("2049");
  await expect(page.getByTestId("nutrient-vitamin_d_ug")).toHaveValue("360"); // 9 µg shown in IU
  await page.getByTestId("targets-save").click();
  await expect(page.getByTestId("meal-summary")).toContainText("2,049 kcal");
  expect((await (await page.request.get("/api/health/targets")).json()).targets).toMatchObject({ energy_kcal: 2049, vitamin_d_ug: 9 });

  // a day as a set
  const setName = `朝 ${uniq()}`;
  await page.getByTestId("day-to-set").click();
  await page.getByTestId("day-to-set-name").fill(setName);
  await page.getByTestId("day-to-set-save").click();
  await expect(page.getByTestId(`set-add-${setName}`)).toBeVisible();

  // add the set to yesterday; today is back with its own row
  const yesterday = new Date(Date.parse(day + "T00:00:00Z") - 86400e3).toISOString().slice(0, 10);
  const yCount = (await (await page.request.get(`/api/health/meals/day?day=${yesterday}`)).json()).entries.length;
  await page.getByTestId("day-prev").click();
  await expect(page.getByTestId("day-label")).toContainText("昨日");
  await expect(page.getByTestId("meal-item")).toHaveCount(yCount);
  await page.getByTestId(`set-add-${setName}`).click();
  await expect(page.getByTestId("meal-item")).toHaveCount(yCount + 1);
  await page.getByTestId("day-next").click();
  await expect(page.getByTestId("day-label")).toContainText("今日");
  await expect(row(page, "ごはん")).toHaveCount(1);

  const sets = await (await page.request.get("/api/health/meals/sets")).json();
  const s = sets.items.find((x: any) => x.name === setName);
  expect(s.items[0]).toMatchObject({ food_name: "ごはん", nutrition_source: "table" });
  await page.request.delete(`/api/health/meals/sets/${s.id}`, { headers: ORIGIN });
  await expect.poll(async () => (await (await page.request.get(`/api/health/meals/day?day=${yesterday}`)).json()).entries.filter((e: any) => e.set_id === s.id).length).toBe(1);
  for (const e of (await (await page.request.get(`/api/health/meals/day?day=${yesterday}`)).json()).entries.filter((x: any) => x.set_id === s.id)) await page.request.delete(`/api/health/meals/entries/${e.id}`, { headers: ORIGIN });
  await page.request.delete(`/api/health/meals/day/${day}`, { headers: ORIGIN });
  await page.request.put("/api/health/targets", { headers: ORIGIN, data: before });
});
