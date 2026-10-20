import { test, expect } from "./helpers";

test("add an invoice: withholding auto-computed, monthly total updates, PDF mismatch flagged", async ({ authed: page }) => {
  await page.goto("/finance");
  await expect(page.locator("h1")).toHaveText("お金");
  const client = `E2E請求先 ${Date.now()}`;
  const year = 2031; // isolated year so totals are deterministic across runs
  await page.getByTestId("finance-add").click();
  await page.getByTestId("invoice-client").fill(client);
  await page.getByTestId("invoice-date").fill(`${year}-03-15`);
  await page.getByTestId("invoice-amount").fill("1500000");
  await expect(page.getByTestId("invoice-tax")).toHaveValue("150000");
  await expect(page.getByTestId("invoice-withholding")).toHaveValue("204200"); // 102,100 + 20.42% of 500,000
  await expect(page.getByTestId("invoice-computed")).toHaveText("1,445,800円");
  await page.getByTestId("invoice-pdf-total").fill("1445810");
  await expect(page.getByTestId("invoice-mismatch-badge")).toBeVisible();
  await page.getByTestId("invoice-save").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByTestId("finance-year").selectOption(String(year));
  const row = page.locator(`[data-testid^="invoice-row-"]`, { hasText: client });
  await expect(row).toBeVisible();
  await expect(row.getByText("PDFと不一致")).toBeVisible();
  const march = page.getByTestId(`month-row-${year}-03`);
  await expect(march).toContainText("不一致");
  const cell = page.getByTestId(`month-withholding-${year}-03`);
  const text = (await cell.textContent()) ?? "";
  expect(Number(text.replace(/[^\d]/g, ""))).toBeGreaterThanOrEqual(204200);
  const total = (await page.getByTestId("finance-total-withholding").textContent()) ?? "";
  expect(Number(total.replace(/[^\d]/g, ""))).toBeGreaterThanOrEqual(204200);

  // cleanup via API so the year stays deterministic
  const res = await page.request.get(`/api/finance?year=${year}`);
  const { invoices } = (await res.json()) as { invoices: { id: string; client: string }[] };
  for (const inv of invoices.filter((i) => i.client === client)) await page.request.delete(`/api/finance/${inv.id}`, { headers: { Origin: "http://localhost:5173" } });
});

test("mail rules: test a subject against rules and save", async ({ authed: page }) => {
  await page.goto("/finance");
  await page.getByTestId("rules-test-subject").fill("【請求書】10月分のご請求");
  await page.getByTestId("rules-test").click();
  await expect(page.getByTestId("rules-test-result")).toContainText("検知");
  await page.getByTestId("rules-test-subject").fill("Starbucks receipt");
  await page.getByTestId("rules-test").click();
  await expect(page.getByTestId("rules-test-result")).toContainText("対象外");
});
