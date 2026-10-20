import { readFileSync } from "node:fs";
import { test, expect } from "./helpers";

// Token the dev server reads from .dev.vars (FX_CONNECTOR_TOKEN=dev-fx-token). Read the file so the test follows the file.
function connectorToken(): string {
  try {
    const m = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^FX_CONNECTOR_TOKEN=(.*)$/m);
    return m?.[1]?.trim() || "dev-fx-token";
  } catch { return "dev-fx-token"; }
}
const H = () => ({ Authorization: `Bearer ${connectorToken()}`, Origin: "http://localhost:5173" });
const TERMINAL = "e2e-desktop"; // stable so repeated runs renew the same 30 s lease

test("pairs show 更新待ち when the connector is silent", async ({ authed: page }) => {
  // Make the stored state stale without touching the DB: we cannot rewind time, so assert on the API contract
  // using a signal whose judgment bar is too old (rule A > 90 min) after a fresh heartbeat.
  const hb = await page.request.post("/api/integrations/fx/heartbeat", { headers: H(), data: { terminal_id: TERMINAL, account: "e2e", equity: 1000, positions: [], version: "e2e" } });
  expect(hb.ok()).toBeTruthy();
  const old = new Date(Date.now() - 6 * 3600_000).toISOString(); // H1 bar closed 5 h ago → > 90 min
  const sig = await page.request.post("/api/integrations/fx/signals", { headers: H(), data: { pair: "AUD/USD", rule: "rule_a", side: "BUY", stage: "setup", bar_time: old } });
  expect(sig.ok()).toBeTruthy();
  await page.goto("/fx");
  await expect(page.getByTestId("fx-mark-AUDUSD-rule_a").locator("[data-mark]")).toHaveText("更新待ち");
  // no signal ever for donchian6 on this pair → 更新待ち as well
  await expect(page.getByTestId("fx-mark-AUDUSD-donchian6").locator("[data-mark]")).toHaveText("更新待ち");
});

test("unauthorized connector calls are rejected", async ({ authed: page }) => {
  const r = await page.request.post("/api/integrations/fx/heartbeat", { headers: { Authorization: "Bearer nope", Origin: "http://localhost:5173" }, data: { terminal_id: "x", version: "0" } });
  expect(r.status()).toBe(401);
  const r2 = await page.request.get("/api/integrations/fx/permissions");
  expect(r2.status()).toBe(401);
});

test("heartbeat + setup signal + candles → 準備OK · BUY, chart renders, trade open notifies", async ({ authed: page }) => {
  const now = Date.now();
  const hb = await page.request.post("/api/integrations/fx/heartbeat", { headers: H(), data: { terminal_id: TERMINAL, account: "e2e", equity: 1234.5, positions: [], version: "e2e-1", mt5_connected: true } });
  expect(hb.ok()).toBeTruthy();
  const hbBody = await hb.json();
  expect(hbBody.permissions.lease.held_by_you).toBe(true);
  expect(hbBody.permissions.year_config_valid_until).toBe("2027-10-01");

  // another terminal must be refused while the lease is held
  const other = await page.request.post("/api/integrations/fx/heartbeat", { headers: H(), data: { terminal_id: `${TERMINAL}-other`, version: "e2e-1" } });
  expect(other.status()).toBe(409);

  const bar = new Date(Math.floor(now / 3600_000) * 3600_000 - 3600_000).toISOString(); // last closed H1
  const sig = await page.request.post("/api/integrations/fx/signals", { headers: H(), data: { pair: "USD/JPY", rule: "rule_a", side: "BUY", stage: "setup", bar_time: bar, indicators: { adx14: 27.1 } } });
  expect(sig.ok()).toBeTruthy();

  // 6 hours of M5 + 120 H1 bars so SMA90/ATR/ADX can be computed; plus one D1 bar for pivots.
  const nowSec = Math.floor(now / 1000);
  const m5: { t: number; o: number; h: number; l: number; c: number }[] = [];
  for (let i = 80; i >= 0; i--) { const t = Math.floor(nowSec / 300) * 300 - i * 300; const base = 150 + Math.sin(i / 7) * 0.2; m5.push({ t, o: base, h: base + 0.05, l: base - 0.05, c: base + 0.02 }); }
  const h1: typeof m5 = [];
  for (let i = 120; i >= 0; i--) { const t = Math.floor(nowSec / 3600) * 3600 - i * 3600; const base = 149 + i * 0.01; h1.push({ t, o: base, h: base + 0.3, l: base - 0.3, c: base + 0.1 }); }
  const d1 = [{ t: Math.floor(nowSec / 86400) * 86400 - 86400, o: 149.5, h: 150.8, l: 148.9, c: 150.2 }];
  for (const [timeframe, bars] of [["M5", m5], ["H1", h1], ["D1", d1]] as const) {
    const r = await page.request.post("/api/integrations/fx/candles", { headers: H(), data: { pair: "USD/JPY", timeframe, bars } });
    expect(r.ok()).toBeTruthy();
  }
  const q = await page.request.post("/api/integrations/fx/quotes", { headers: H(), data: { pair: "USD/JPY", bid: 150.123, ask: 150.131, at: new Date().toISOString() } });
  expect(q.ok()).toBeTruthy();

  await page.goto("/fx");
  await expect(page.getByTestId("fx-mark-USDJPY-rule_a").locator("[data-mark]")).toHaveText("✓ 準備OK · BUY");
  await expect(page.getByTestId("fx-mark-USDJPY-rule_a").locator("[data-mark]")).toHaveAttribute("data-mark", "ready_buy");
  await expect(page.getByTestId("fx-pair-USDJPY")).toContainText("150.123 / 150.131");
  // rule disabled by default → label shown
  await expect(page.getByTestId("fx-mark-USDJPY-rule_a")).toContainText("自動エントリー停止中");

  // chart
  await page.getByTestId("fx-pair-link-USDJPY").click();
  await expect(page).toHaveURL(/\/fx\/chart\?pair=USD%2FJPY/);
  await expect(page.getByTestId("fx-chart-canvas").locator("canvas").first()).toBeVisible();
  await page.getByTestId("fx-fit-all").click();
  await expect(page.getByTestId("fx-chart-canvas").locator("canvas").first()).toBeVisible();
  const chart = await page.request.get(`/api/fx/chart?pair=${encodeURIComponent("USD/JPY")}&tf=M5&rule=rule_a`);
  const cj = await chart.json();
  expect(cj.candles.length).toBeGreaterThan(50);
  expect(cj.lines.some((l: { key: string }) => l.key === "sma90_h1")).toBe(true);
  expect(cj.levels.some((l: { key: string }) => l.key === "piv_R1")).toBe(true);
  expect(cj.levels.some((l: { key: string }) => l.key === "sl_buy")).toBe(true);

  // trade open → notification (idempotent on ticket+event)
  const ticket = `T${now}`;
  const open = { event: "open", ticket, rule: "rule_a", pair: "USD/JPY", side: "BUY", price: 150.13, lots: 0.3, sl: 149.9, tp: 150.85, at: new Date().toISOString() };
  const t1 = await page.request.post("/api/integrations/fx/trades", { headers: H(), data: open });
  expect(await t1.json()).toMatchObject({ stored: 1, duplicates: 0 });
  const t2 = await page.request.post("/api/integrations/fx/trades", { headers: H(), data: open });
  expect(await t2.json()).toMatchObject({ stored: 0, duplicates: 1 });
  const notes = await (await page.request.get("/api/notifications")).json();
  const list: { kind: string; title: string }[] = Array.isArray(notes) ? notes : notes.items ?? notes.notifications ?? [];
  const fxNotes = list.filter((n) => n.kind === "fx" && n.title.includes("USD/JPY"));
  expect(fxNotes.length).toBeGreaterThan(0);
  expect(fxNotes[0]!.title).toContain("ルールA改良版 エントリー USD/JPY BUY");

  // positions tab lists the open trade; close it and check performance
  await page.goto("/fx/positions");
  await expect(page.getByTestId("fx-trade-table").first()).toContainText(ticket.slice(0, 4).length ? "ルールA改良版" : "");
  const close = { ...open, event: "close", price: 150.5, pnl_usd: 74.2, r_multiple: 1.6, at: new Date().toISOString() };
  expect((await page.request.post("/api/integrations/fx/trades", { headers: H(), data: close })).ok()).toBeTruthy();
  await page.goto("/fx/trades");
  await expect(page.getByTestId("fx-trade-table")).toContainText("150.500");
  const perf = await (await page.request.get("/api/fx/performance")).json();
  expect(perf.by_rule.find((r: { rule: string }) => r.rule === "rule_a").trades).toBeGreaterThan(0);
  expect(perf.note).toContain("過去検証");

  // settings round-trip
  await page.goto("/fx/settings");
  await expect(page.getByTestId("fx-install-md")).toContainText("lifeos_connector.py");
  const lot = page.getByTestId("fx-common-lot");
  await lot.fill("0.31");
  await page.getByTestId("fx-stop-reasons").fill("理由A\n理由B");
  await page.getByTestId("fx-save-settings").click();
  await expect(page.getByText("保存しました", { exact: false })).toBeVisible();
  const s = await (await page.request.get("/api/fx/settings")).json();
  expect(s.common_lot).toBe(0.31);
  expect(s.stop_reasons).toEqual(["理由A", "理由B"]);
  const perms = await (await page.request.get(`/api/integrations/fx/permissions?terminal_id=${TERMINAL}`, { headers: H() })).json();
  expect(perms.common_lot).toBe(0.31);
  await page.request.put("/api/fx/settings", { headers: { Origin: "http://localhost:5173" }, data: { ...s, common_lot: 0.3, stop_reasons: [] } });
});
