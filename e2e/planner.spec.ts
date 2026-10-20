import { test, expect, type Page } from "./helpers";

const ORIGIN = { Origin: "http://localhost:5173" };

/** Today's date as the browser (Asia/Tokyo) sees it. */
const browserToday = (page: Page) => page.evaluate(() => {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});

async function createItem(page: Page, body: Record<string, unknown>) {
  const res = await page.request.post("/api/planner", { data: body, headers: ORIGIN });
  expect(res.ok()).toBeTruthy();
  return (await res.json() as { item: { id: string; title: string } }).item;
}

async function openPlanner(page: Page) {
  await page.goto("/planner");
  await expect(page.getByTestId("week-grid")).toBeVisible();
}

test("add button creates a task that lands in today's all-day row", async ({ authed: page }) => {
  await openPlanner(page);
  const today = await browserToday(page);
  const title = `task-${Date.now()}`;
  await page.getByTestId("add-button").click();
  await expect(page.getByTestId("add-modal")).toBeVisible();
  await page.getByTestId("add-type-task").click();
  await page.getByTestId("add-title").fill(title);
  await page.getByTestId("add-date").fill(today);
  await page.getByTestId("add-submit").click();
  await expect(page.getByTestId("add-modal")).toBeHidden();
  await expect(page.getByTestId(`allday-cell-${today}`)).toContainText(title);
  await expect(page.getByTestId("undated-list")).not.toContainText(title);
});

test("double-clicking a grid cell creates an event at that hour", async ({ authed: page }) => {
  const today = await browserToday(page);
  const HOUR = 4; // early morning: keep the cell free of real items
  // Idempotency: an event left on this cell by a previous run would cover it, so archive those first.
  const cellIso = await page.evaluate((h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); }, HOUR);
  const list = await (await page.request.get(`/api/planner?from=${today}`, { headers: ORIGIN })).json() as { items: { id: string; type: string; start_at: string | null }[] };
  for (const it of list.items) {
    if (it.type === "event" && it.start_at === cellIso) await page.request.delete(`/api/planner/${it.id}`, { headers: ORIGIN });
  }
  await openPlanner(page);
  const title = `event-${Date.now()}`;
  await page.getByTestId(`hour-cell-${today}-${HOUR}`).dblclick();
  await expect(page.getByTestId("add-modal")).toBeVisible();
  await expect(page.getByTestId("add-start")).toHaveValue(`${today}T0${HOUR}:00`);
  await page.getByTestId("add-title").fill(title);
  await page.getByTestId("add-submit").click();
  await expect(page.getByTestId("add-modal")).toBeHidden();
  const block = page.getByTestId("week-grid").locator('[data-type="event"]', { hasText: title });
  await expect(block).toBeVisible();
  await expect(block).toContainText(`0${HOUR}:00–0${HOUR + 1}:00`);
});

test("completing a task moves it to the collapsed done group", async ({ authed: page }) => {
  const today = await browserToday(page);
  const item = await createItem(page, { type: "task", title: `done-${Date.now()}`, date: today });
  await openPlanner(page);
  await page.getByTestId(`item-${item.id}`).click();
  await expect(page.getByTestId("item-modal")).toBeVisible();
  await page.getByTestId("item-done").click();
  await expect(page.getByTestId("item-modal")).toBeHidden();
  await expect(page.getByTestId(`allday-cell-${today}`)).not.toContainText(item.title);
  await expect(page.getByTestId("done-list")).toHaveCount(0); // collapsed by default
  await page.getByTestId("done-toggle").click();
  await expect(page.getByTestId("done-list")).toContainText(item.title);
});

test("unscheduling moves an item to the undated list", async ({ authed: page }) => {
  const today = await browserToday(page);
  const item = await createItem(page, { type: "task", title: `undate-${Date.now()}`, date: today });
  await openPlanner(page);
  await page.getByTestId(`item-${item.id}`).click();
  await page.getByTestId("item-unschedule").click();
  await expect(page.getByTestId("item-modal")).toBeHidden();
  await expect(page.getByTestId("undated-list")).toContainText(item.title);
  await expect(page.getByTestId(`allday-cell-${today}`)).not.toContainText(item.title);
});

test("dragging an undated task onto a day schedules it", async ({ authed: page }) => {
  const today = await browserToday(page);
  const item = await createItem(page, { type: "task", title: `drag-${Date.now()}` });
  await openPlanner(page);
  await expect(page.getByTestId("undated-list")).toContainText(item.title);
  await page.getByTestId(`item-${item.id}`).dragTo(page.getByTestId(`allday-cell-${today}`));
  await expect(page.getByTestId(`allday-cell-${today}`)).toContainText(item.title);
  await expect(page.getByTestId("undated-list")).not.toContainText(item.title);
});

test("deleting an item removes it from the page", async ({ authed: page }) => {
  const today = await browserToday(page);
  const item = await createItem(page, { type: "task", title: `del-${Date.now()}`, date: today });
  await openPlanner(page);
  await page.getByTestId(`item-${item.id}`).click();
  await page.getByTestId("item-delete").click();
  await page.getByTestId("item-delete-confirm").click();
  await expect(page.getByTestId("item-modal")).toBeHidden();
  await expect(page.getByTestId(`item-${item.id}`)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await expect(page.getByTestId(`item-${item.id}`)).toHaveCount(0);
});

test("a failed first load shows an error with retry instead of an endless skeleton", async ({ authed: page }) => {
  let fail = true;
  await page.route("**/api/planner?*", async (route) => {
    if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal error" }) });
    else await route.continue();
  });
  await page.goto("/planner");
  await expect(page.getByTestId("load-retry")).toBeVisible();
  await expect(page.getByTestId("page-skeleton")).toHaveCount(0);
  fail = false;
  await page.getByTestId("load-retry").click();
  await expect(page.getByTestId("week-grid")).toBeVisible();
});
