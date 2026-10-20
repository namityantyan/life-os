import { test, expect } from "./helpers";

const H = { Origin: "http://localhost:5173" };

/** Close any open session so the test starts from the part-picker (idempotent). */
async function closeOpenSession(page: import("@playwright/test").Page) {
  const r = await page.request.get("/api/training/active");
  const j = (await r.json()) as { session: { id: string } | null };
  if (j.session) await page.request.post(`/api/training/sessions/${j.session.id}/finish`, { headers: H });
}

/** Remove earlier bench press sets so the best record is the one this test logs (shared local DB). */
async function clearExercise(page: import("@playwright/test").Page, key: string) {
  const r = await page.request.get(`/api/training/exercises/${key}/history?limit=500`);
  const j = (await r.json()) as { sets: { id: string }[] };
  for (const s of j.sets) await page.request.delete(`/api/training/sets/${s.id}`, { headers: H });
}

test("training: start a session, log two bench press sets, finish, verify 1RM and history", async ({ authed: page }) => {
  await closeOpenSession(page);
  await clearExercise(page, "bench_press");
  await page.goto("/training");
  await expect(page.locator("h1")).toHaveText("トレーニング");
  await expect(page).toHaveTitle(/トレーニング/);

  // Start a chest session.
  await page.getByTestId("part-chip-胸").click();
  await expect(page.getByTestId("active-part")).toHaveText("胸");
  await expect(page.getByTestId("rest-timer")).toHaveAttribute("data-state", "idle");

  // Pick ベンチプレス from the search.
  await page.getByTestId("exercise-search").fill("ベンチプレス");
  await page.getByTestId("exercise-option-bench_press").click();
  await expect(page.getByTestId("selected-exercise")).toHaveText("ベンチプレス");
  await expect(page.getByTestId("advice")).toBeVisible();

  // Set 1: 60kg × 8.
  await page.getByTestId("set-weight").fill("60");
  await page.getByTestId("set-reps").fill("8");
  await page.getByTestId("set-submit").click();
  await expect(page.getByTestId("set-row")).toHaveCount(1);
  await expect(page.getByTestId("rest-timer")).toHaveAttribute("data-state", "running");

  // Set 2: 62.5kg × 5.
  await page.getByTestId("set-weight").fill("62.5");
  await page.getByTestId("set-reps").fill("5");
  await page.getByTestId("set-submit").click();
  await expect(page.getByTestId("set-row")).toHaveCount(2);
  await expect(page.getByTestId("set-row").nth(1)).toContainText("62.5kg × 5");

  // Finish → navigates to the session detail in 履歴.
  await page.getByTestId("finish-session").click();
  await page.getByTestId("finish-confirm").click();
  await expect(page).toHaveURL(/\/training\/history\/[0-9a-f-]+/);
  await expect(page.getByTestId("detail-part")).toHaveText("胸");
  await expect(page.getByTestId("detail-set")).toHaveCount(2);
  const sessionId = page.url().split("/").pop()!;

  // 重量・1RM tab: best is 62.5 (max weight across all sets, not the first set), est 1RM ≈ 72.9.
  await page.getByTestId("tab-records").click();
  const row = page.getByTestId("record-row-bench_press");
  await expect(row).toBeVisible();
  await expect(row.getByTestId("record-weight")).toHaveText("62.5kg");
  await expect(row.getByTestId("record-1rm")).toContainText("72.9kg");
  await expect(row.getByTestId("record-1rm")).not.toContainText("参考値");

  // 履歴 tab lists the session.
  await page.getByTestId("tab-history").click();
  await expect(page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)).toBeVisible();

  // API: the finish notification was created once (dedupe on session id).
  const notif = await page.request.get("/api/notifications");
  const items = ((await notif.json()) as { items: { kind: string; url: string | null }[] }).items;
  expect(items.filter((n) => n.kind === "training" && n.url === `/training/history/${sessionId}`).length).toBe(1);
});

test("training: catalog search and filters, legacy duplicates noted", async ({ authed: page }) => {
  await page.goto("/training/catalog");
  await expect(page.getByTestId("catalog-item")).toHaveCount(97);
  await page.getByTestId("catalog-part-胸").click();
  await expect(page.getByTestId("catalog-item")).toHaveCount(15);
  await page.getByTestId("catalog-part-all").click();
  await page.getByTestId("catalog-search").fill("ショルダープレス");
  await expect(page.getByTestId("catalog-item").first()).toBeVisible();
  await expect(page.getByText("重複統合：旧 imp_239fbb16")).toBeVisible();
});

test("training: natural-text logging through the API is reflected in records (bodyweight has no 1RM)", async ({ authed: page }) => {
  await closeOpenSession(page);
  // Log via the sessions API the way the Discord module will (bodyweight exercise → no 1RM).
  const start = await page.request.post("/api/training/sessions", { headers: H, data: { part: "背中" } });
  const { session } = (await start.json()) as { session: { id: string } };
  const r = await page.request.post(`/api/training/sessions/${session.id}/sets`, { headers: H, data: { exercise_key: "pull_up", reps: 9 } });
  expect(r.status()).toBe(201);
  await page.request.post(`/api/training/sessions/${session.id}/finish`, { headers: H });
  await page.goto("/training/records");
  const row = page.getByTestId("record-row-pull_up");
  await expect(row).toBeVisible();
  await expect(row.getByTestId("record-weight")).toHaveText("—");
  await expect(row.getByTestId("record-1rm")).toHaveText("—");
});

test("training: a client-supplied unit cannot turn a weighted exercise into bodyweight (weight kept, unit from catalog)", async ({ authed: page }) => {
  await closeOpenSession(page);
  const start = await page.request.post("/api/training/sessions", { headers: H, data: { part: "胸" } });
  const { session } = (await start.json()) as { session: { id: string } };
  const r = await page.request.post(`/api/training/sessions/${session.id}/sets`, { headers: H, data: { exercise_key: "bench_press", weight: 40, reps: 5, unit: "bodyweight" } });
  expect(r.status()).toBe(201);
  const { set } = (await r.json()) as { set: { id: string; unit: string; weight: number | null } };
  expect(set.unit).toBe("total");
  expect(set.weight).toBe(40);
  // weighted set without a weight is rejected instead of being stored as "—"
  const bad = await page.request.post(`/api/training/sessions/${session.id}/sets`, { headers: H, data: { exercise_key: "bench_press", reps: 5 } });
  expect(bad.status()).toBe(400);
  await page.request.delete(`/api/training/sets/${set.id}`, { headers: H });
  await page.request.delete(`/api/training/sessions/${session.id}`, { headers: H });
});
