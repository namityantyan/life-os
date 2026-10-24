import { test, expect } from "./helpers";
import type { Page } from "@playwright/test";

// The local dev server has no IMGGEN_URL / IMGGEN_TOKEN, so the real API reports "unconfigured".
// The second and third tests mock /api/images/* in the browser to drive the online flow.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const now = new Date().toISOString();
const gen = (over: Record<string, unknown> = {}) => ({
  id: "g1", prompt_text: "花畑の白ワンピの女の子", tags: "1girl, solo, flower garden, white dress", rating: "all_ages", count: 1, seed: null,
  status: "queued", progress_done: 0, queue_position: 1, error: null, created_at: now, updated_at: now, files: [], ...over,
});
const done = gen({ status: "done", progress_done: 1, queue_position: null, files: [{ id: "f1", idx: 0, filename: "a.png", seed: 4242, bytes: PNG.length, created_at: now }] });

async function mockOnline(page: Page, opts: { items?: unknown[]; generate?: { status: number; body: unknown } } = {}) {
  await page.route("**/api/images/status", (r) => r.fulfill({ json: { status: { state: "online", message: null, comfyui: "up", model_available: true, queue_length: 0 } } }));
  let items = opts.items ?? [];
  await page.route("**/api/images", (r) => r.fulfill({ json: { items } }));
  await page.route("**/api/images/generate", (r) => {
    const g = opts.generate ?? { status: 201, body: { item: gen() } };
    if (g.status === 201) items = [(g.body as { item: unknown }).item, ...items];
    return r.fulfill({ status: g.status, json: g.body });
  });
  await page.route("**/api/images/jobs/*", (r) => { items = [done]; return r.fulfill({ json: { item: done, offline: false } }); });
  await page.route("**/api/images/files/*", (r) => {
    if (r.request().method() === "DELETE") { items = []; return r.fulfill({ json: { ok: true } }); }
    return r.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
}

test("images: offline / unconfigured state without the Mac service", async ({ authed: page }) => {
  await page.goto("/images");
  await expect(page.locator("h1")).toHaveText("画像生成");
  await expect(page.getByTestId("images-offline")).toBeVisible();
  await expect(page.getByTestId("images-offline")).not.toContainText("Error");
  await page.getByTestId("images-prompt").fill("猫");
  await expect(page.getByTestId("images-generate")).toBeDisabled();
  await page.getByTestId("images-recheck").click();
  await expect(page.getByTestId("images-offline")).toBeVisible();
});

test("images: generate (Cmd/Ctrl+Enter), progress, gallery, detail, delete — mocked backend", async ({ authed: page }) => {
  await mockOnline(page);
  await page.goto("/images");
  await expect(page.getByTestId("images-offline")).toHaveCount(0);
  const ta = page.getByTestId("images-prompt");
  await ta.fill("花畑の白ワンピの女の子");
  await ta.press("Enter"); // newline, not send
  await expect(ta).toHaveValue("花畑の白ワンピの女の子\n");
  await page.getByTestId("images-count").getByRole("tab", { name: "2枚" }).click();
  const req = page.waitForRequest((r) => r.url().endsWith("/api/images/generate") && r.method() === "POST");
  await ta.press("ControlOrMeta+Enter");
  expect((await req).postDataJSON()).toMatchObject({ text: "花畑の白ワンピの女の子", count: 2, rating: "all_ages" });
  await expect(ta).toHaveValue("");
  // the poll resolves the job and the tile appears
  await expect(page.getByTestId("images-tile")).toHaveCount(1, { timeout: 10_000 });
  await page.getByTestId("images-tile").first().click();
  await expect(page.getByTestId("images-detail")).toBeVisible();
  await expect(page.getByTestId("images-tags")).toHaveText("1girl, solo, flower garden, white dress");
  await expect(page.getByTestId("images-seed-value")).toHaveText("4242");
  await expect(page.getByTestId("images-download")).toHaveAttribute("href", "/api/images/files/f1?download=1");
  await page.getByTestId("images-delete").click();
  await expect(page.getByTestId("images-detail")).toHaveCount(0);
  await expect(page.getByTestId("images-tile")).toHaveCount(0);
});

test("images: refusal message is shown inline", async ({ authed: page }) => {
  await mockOnline(page, { generate: { status: 422, body: { error: "実在の人物は生成できません。", code: "refused" } } });
  await page.goto("/images");
  await page.getByTestId("images-prompt").fill("有名な俳優");
  await page.getByTestId("images-generate").click();
  await expect(page.getByTestId("images-refused")).toHaveText("実在の人物は生成できません。");
});

test("images: a job in progress survives a reload", async ({ authed: page }) => {
  await mockOnline(page, { items: [gen({ status: "running", progress_done: 0 })] });
  await page.route("**/api/images/jobs/*", (r) => r.fulfill({ json: { item: gen({ status: "running", progress_done: 0 }), offline: true } }));
  await page.goto("/images");
  await expect(page.getByTestId("images-pending")).toHaveCount(1);
  await expect(page.getByTestId("images-jobs-offline")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("images-pending")).toHaveCount(1);
});
