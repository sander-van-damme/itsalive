import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://itsalive.localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--host-resolver-rules=MAP *.localhost 127.0.0.1,MAP itsalive.localhost 127.0.0.1",
        "--no-proxy-server",
      ],
    },
  },
  webServer: [
    {
      command: "npm run build:runtime && npm run dev -- --host 0.0.0.0",
      env: { ITSALIVE_E2E: "1" },
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npm run dev:app -- --host 0.0.0.0",
      env: { ITSALIVE_E2E: "1" },
      url: "http://127.0.0.1:4174",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
