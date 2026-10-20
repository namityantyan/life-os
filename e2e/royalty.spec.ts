import { test, expect } from "./helpers";

test("register a manual mail → classified as NexTone target with month; change status and processed", async ({ authed: page }) => {
  await page.goto("/royalty");
  await expect(page.locator("h1")).toHaveText("明細");
  const subject = `【NexTone】配信使用料分配明細公開のお知らせ 2029年4月 ${Date.now()}`;
  await page.getByTestId("royalty-manual").click();
  await page.getByTestId("manual-subject").fill(subject);
  await page.getByTestId("manual-sender").fill("info@nex-tone.co.jp");
  await page.getByTestId("manual-save").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const row = page.locator('[data-testid^="mail-row-"]', { hasText: subject });
  await expect(row).toBeVisible();
  const id = (await row.getAttribute("data-testid"))!.replace("mail-row-", "");
  await expect(page.getByTestId(`mail-provider-${id}`)).toHaveText("NexTone");
  await expect(page.getByTestId(`mail-status-badge-${id}`)).toHaveText("対象");
  await expect(row).toContainText("2029年4月");

  await page.getByTestId(`mail-status-${id}`).getByRole("button", { name: "要確認" }).click();
  await expect(page.getByTestId(`mail-status-badge-${id}`)).toHaveText("要確認");
  await page.getByTestId(`mail-processed-${id}`).getByRole("switch").click();
  await expect(page.getByTestId(`mail-processed-${id}`).getByRole("switch")).toHaveAttribute("aria-checked", "true");

  // persisted
  const res = await page.request.get(`/api/royalty?status=review`);
  const { mails } = (await res.json()) as { mails: { id: string; status: string; processed: boolean }[] };
  const m = mails.find((x) => x.id === id);
  expect(m?.status).toBe("review"); expect(m?.processed).toBe(true);
  await page.request.delete(`/api/royalty/${id}`, { headers: { Origin: "http://localhost:5173" } });
});

test("purchase receipts are excluded", async ({ authed: page }) => {
  const res = await page.request.post("/api/royalty/manual", { headers: { Origin: "http://localhost:5173" }, data: { subject: `Google Play のご注文の領収書 ${Date.now()}`, sender: "googleplay-noreply@google.com" } });
  expect(res.status()).toBe(201);
  const m = (await res.json()) as { id: string; status: string };
  expect(m.status).toBe("excluded");
  await page.request.delete(`/api/royalty/${m.id}`, { headers: { Origin: "http://localhost:5173" } });
});
