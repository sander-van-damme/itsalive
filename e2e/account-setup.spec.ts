import { test, expect } from "@playwright/test";
import { installGoalProvider } from "./fixtures/goal-provider";

test("ChatGPT plan loads account models and creates an app without placing OAuth tokens in browser storage", async ({
  page,
  context,
}) => {
  const provider = await installGoalProvider(context);
  await context.route("http://127.0.0.1:1456/session", (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: {
        connected: true,
        sharing: true,
        email: "test@example.test",
        csrf: "browser-session-header",
      },
    }),
  );
  await context.route("http://127.0.0.1:1456/models", (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
          },
        })
      : route.fulfill({
          headers: { "access-control-allow-origin": "*" },
          json: {
            models: [
              {
                slug: "gpt-6.1-sol",
                display_name: "Sol for this account",
                visibility: "list",
              },
              {
                slug: "hidden-model",
                display_name: "Hidden",
                visibility: "hide",
              },
            ],
          },
        }),
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Create a violin practice app.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const settings = page.locator("#settings-dialog");
  await settings
    .getByRole("combobox", { name: "Connect with", exact: true })
    .selectOption("chatgpt");
  await expect(settings.locator("#chatgpt-status")).toContainText(
    "plan usage enabled",
  );
  await settings.getByText("AI choices", { exact: true }).click();
  await expect(settings.getByLabel("Low model", { exact: true })).toHaveValue(
    "gpt-6.1-sol",
  );
  await expect(
    settings.getByLabel("Low model", { exact: true }).locator("option"),
  ).toHaveText(["Sol for this account"]);
  await settings
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(settings).not.toBeVisible();
  await expect(
    page
      .frameLocator('iframe[data-mode="app"]')
      .getByRole("heading", { name: "Violin practice", exact: true }),
  ).toBeVisible();
  expect(
    provider.requests.some((request) =>
      request.tools?.some((tool) => tool.function.name === "write_file"),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("itsalive.credentials")!),
    ),
  ).toEqual({ openai: "" });
  await expect(page.locator("#provider-badge")).toContainText("AI connected");
  await page
    .getByRole("button", { name: "Start voice conversation", exact: true })
    .click();
  await expect(settings).toContainText(
    "Add an OpenAI API key to use live voice",
  );
});
