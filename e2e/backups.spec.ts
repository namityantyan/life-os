import { test, expect } from "./helpers";

const TOKEN = "dev-backup-token";

test("ingest: 201 on new run, 200 on resend, 401 on bad token; UI shows the run", async ({ authed: page }) => {
  const runId = `e2e-${Date.now()}`;
  const content = { started_at: "2026-10-20T02:00:00+09:00", finished_at: "2026-10-20T02:12:30+09:00", duration_sec: 750, personal: { count: 1234, bytes: 5_368_709_120 }, team: { count: 56, bytes: 1_048_576 }, errors: 0, verdict: "success" };
  const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  const first = await page.request.post("/api/integrations/backups", { headers, data: { run_id: runId, content } });
  expect(first.status()).toBe(201);
  const again = await page.request.post("/api/integrations/backups", { headers, data: { run_id: runId, content } });
  expect(again.status()).toBe(200);
  expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true);
  // A retry whose body differs (e.g. an added field) is still the same run: idempotent 200, first receipt kept.
  const changed = await page.request.post("/api/integrations/backups", { headers, data: { run_id: runId, content: { ...content, retry: 1 } } });
  expect(changed.status()).toBe(200);
  expect(((await changed.json()) as { duplicate: boolean; content_changed: boolean })).toMatchObject({ duplicate: true, content_changed: true });
  const bad = await page.request.post("/api/integrations/backups", { headers: { ...headers, Authorization: "Bearer nope" }, data: { run_id: `${runId}-x`, content } });
  expect(bad.status()).toBe(401);

  await page.goto("/backups");
  await expect(page.locator("h1")).toHaveText("バックアップ");
  await expect(page.getByTestId("backup-latest")).toContainText(runId);
  await expect(page.getByTestId("backup-latest-verdict")).toHaveText("成功");
  await expect(page.getByTestId("backup-latest")).toContainText("12分30秒");
  await expect(page.getByTestId("backup-latest")).toContainText("1,234件");
  await expect(page.getByTestId("backup-latest")).toContainText("5.0 GB");
  await expect(page.getByTestId(`backup-run-${runId}`)).toBeVisible();
  await expect(page.getByTestId("backup-stale")).toHaveCount(0);
  await expect(page.getByTestId("backup-settings")).toContainText("/api/integrations/backups");
  await expect(page.getByTestId("backup-settings")).not.toContainText(TOKEN);
});

test("latest endpoint reports stale=false right after a receipt and errors force failure verdict", async ({ authed: page }) => {
  const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  const res = await page.request.post("/api/integrations/backups", { headers, data: { run_id: `e2e-err-${Date.now()}`, content: { verdict: "success", errors: 3 } } });
  expect(res.status()).toBe(201);
  expect(((await res.json()) as { verdict: string }).verdict).toBe("error");
  const latest = (await (await page.request.get("/api/backups/latest")).json()) as { stale: boolean; latest: { verdict: string } };
  expect(latest.stale).toBe(false);
  expect(latest.latest.verdict).toBe("error");
});
