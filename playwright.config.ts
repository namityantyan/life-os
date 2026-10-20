import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure", locale: "ja-JP", timezoneId: "Asia/Tokyo" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: { command: "npm run dev -- --port 5173 --strictPort", url: "http://localhost:5173/api/health", reuseExistingServer: true, timeout: 60_000 },
});
