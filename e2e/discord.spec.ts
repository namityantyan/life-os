import { test, expect } from "./helpers";

const origin = { Origin: "http://localhost:5173" };

test("link-code: returns a 6-char one-time code", async ({ authed: page }) => {
  const res = await page.request.post("/api/discord/link-code", { headers: origin });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
  expect(body.command).toBe(`/link code:${body.code}`);
});

test("simulate: dashboard URL request returns a link", async ({ authed: page }) => {
  const res = await page.request.post("/api/discord/simulate", { headers: origin, data: { text: "ダッシュボードのURL" } });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.message).toContain("/");
  expect(body.message).toContain("http://localhost:5173/");
  expect(body.action).toBe("dashboard");

  const assets = await (await page.request.post("/api/discord/simulate", { headers: origin, data: { text: "資産のURL" } })).json();
  expect(assets.message).toContain("/assets");
});

test("simulate: conversation returns a reply (fallback OK) and is stored in history", async ({ authed: page }) => {
  const res = await page.request.post("/api/discord/simulate", { headers: origin, data: { text: "こんにちは" } });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(typeof body.message).toBe("string");
  expect(body.message.length).toBeGreaterThan(0);
  expect(["workers-ai", "fallback"]).toContain(body.provider);

  const hist = await (await page.request.get("/api/discord/history")).json();
  expect(hist.items.some((m: { role: string; content: string }) => m.role === "user" && m.content === "こんにちは")).toBeTruthy();
  expect(hist.items.some((m: { role: string }) => m.role === "assistant")).toBeTruthy();
});

test("status + settings card render", async ({ authed: page }) => {
  const st = await (await page.request.get("/api/discord/status")).json();
  expect(st.interactions_url).toContain("/api/integrations/discord/interactions");
  expect(st.commands.map((c: { name: string }) => c.name)).toContain("chat");

  await page.goto("/settings");
  await expect(page.getByTestId("discord-card")).toBeVisible({ timeout: 20000 });
  await page.getByTestId("discord-link-code").click();
  await expect(page.getByTestId("discord-code")).toHaveText(/^[A-Z0-9]{6}$/);
});

test("interactions endpoint rejects unsigned requests with 401", async ({ page }) => {
  const res = await page.request.post("/api/integrations/discord/interactions", { data: { type: 1 } });
  expect(res.status()).toBe(401);
  const bad = await page.request.post("/api/integrations/discord/interactions", {
    headers: { "X-Signature-Ed25519": "00", "X-Signature-Timestamp": "1" }, data: { type: 1 },
  });
  expect(bad.status()).toBe(401);
});
