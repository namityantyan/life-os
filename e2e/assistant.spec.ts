import { test, expect } from "./helpers";

const H = { Origin: "http://localhost:5173" };

test("assistant: opens via button and ⌘J, chat persists, briefing chips render", async ({ authed: page }) => {
  await page.request.delete("/api/assistant/history", { headers: H });
  await page.getByTestId("assistant-button").click();
  await expect(page.getByTestId("assistant-panel")).toBeVisible();
  await expect(page.getByTestId("assistant-briefing")).toContainText("タスク");
  await expect(page.getByTestId("assistant-briefing")).toContainText("睡眠");
  await expect(page.getByTestId("assistant-prompt")).toHaveCount(3);
  await page.getByTestId("assistant-close").click();
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("assistant-panel")).toBeVisible();
  const input = page.getByTestId("assistant-input").getByLabel("メッセージ");
  await expect(input).toBeFocused();
  const text = `asst-${Date.now()} 今日は何を優先する？`;
  await input.fill(text);
  await input.press("Enter");
  const log = page.getByTestId("assistant-panel").getByTestId("chat-log");
  await expect(log).toContainText(text);
  await expect(log.locator("div.bg-fill").last()).not.toBeEmpty({ timeout: 20000 });
  // persists across reload
  await page.reload();
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("assistant-panel").getByTestId("chat-log")).toContainText(text);
  const hist = await (await page.request.get("/api/assistant/history")).json();
  expect(hist.items.length).toBeGreaterThanOrEqual(2);
  expect(hist.items[hist.items.length - 1].role).toBe("assistant");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("assistant-panel")).toHaveCount(0);
});

test("assistant: apply a task action and see it on the dashboard; invalid actions rejected", async ({ authed: page }) => {
  const title = `asst-task-${Date.now()}`;
  const r = await page.request.post("/api/assistant/apply", { headers: H, data: { action: { type: "task", title } } });
  expect(r.status()).toBe(201);
  const j = await r.json();
  expect(j.item.type).toBe("task");
  await page.reload();
  await expect(page.getByTestId("dash-task-list")).toContainText(title, { timeout: 10000 });
  const bad = await page.request.post("/api/assistant/apply", { headers: H, data: { action: { type: "email", title: "x" } } });
  expect(bad.status()).toBe(400);
  const empty = await page.request.post("/api/assistant/apply", { headers: H, data: { action: { type: "task", title: "   " } } });
  expect(empty.status()).toBe(400);
  const b = await (await page.request.get("/api/assistant/briefing")).json();
  expect(Array.isArray(b.briefing.chips)).toBeTruthy();
  expect(b.briefing.tasks_open).toBeGreaterThanOrEqual(1);
});

test("dashboard layout: hide FX persists, restore, move a card up persists", async ({ authed: page }) => {
  await page.request.put("/api/settings/dashboard_layout", { headers: H, data: [] });
  await page.reload();
  await expect(page.getByTestId("dash-card-fx")).toBeVisible();
  await page.getByTestId("dash-edit").click();
  await page.getByTestId("dash-card-hide-fx").click();
  await expect(page.getByTestId("dash-card-fx")).toHaveCount(0);
  await expect(page.getByTestId("dash-card-show-fx")).toBeVisible();
  await page.getByTestId("dash-edit").click(); // 完了
  await page.reload();
  await expect(page.getByTestId("dash-card-clock")).toBeVisible();
  await expect(page.getByTestId("dash-card-fx")).toHaveCount(0);
  const saved = await (await page.request.get("/api/settings")).json();
  expect(saved.settings.dashboard_layout.find((e: any) => e.id === "fx").hidden).toBe(true);

  // restore + move weather above clock
  await page.getByTestId("dash-edit").click();
  await page.getByTestId("dash-card-show-fx").click();
  await expect(page.getByTestId("dash-card-fx")).toBeVisible();
  await expect(page.getByTestId("dash-card-up-clock")).toBeDisabled();
  await page.getByTestId("dash-card-up-weather").click();
  await page.getByTestId("dash-edit").click();
  await page.reload();
  await expect(page.getByTestId("dash-card-fx")).toBeVisible();
  const ids = await page.locator("[data-testid^='dash-card-']:not([data-testid*='-controls-'])").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(ids.slice(0, 2)).toEqual(["dash-card-weather", "dash-card-clock"]);
  // not editing: no controls
  await expect(page.getByTestId("dash-card-hide-fx")).toHaveCount(0);
  await page.request.put("/api/settings/dashboard_layout", { headers: H, data: [] });
});
