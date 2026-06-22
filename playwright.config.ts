import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: "bun run --filter '@coffer/server' dev",
      url: "http://localhost:3001/api/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "bun run --filter '@coffer/web' dev",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
