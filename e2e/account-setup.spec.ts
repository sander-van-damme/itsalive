import { test, expect, type BrowserContext } from "@playwright/test";
import { installGoalProvider } from "./fixtures/goal-provider";

test("local ChatGPT helper loads account models and preserves its existing credential boundary", async ({
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
    .getByRole("button", { name: "Create an app", exact: true })
    .click();
  await page
    .locator('#create-form textarea[name="idea"]')
    .fill("Create a violin practice app.");
  await page.locator('#create-form button[type="submit"]').click();
  const settings = page.locator("#onboarding-dialog");
  await settings
    .getByRole("combobox", { name: "Connect with", exact: true })
    .selectOption("chatgpt");
  await expect(settings.locator("#onboarding-chatgpt-status")).toContainText(
    "plan usage enabled",
  );
  await expect(settings.locator(".advanced-settings")).toBeHidden();
  await expect(settings.getByLabel("Low model", { exact: true })).toHaveValue(
    "gpt-6.1-sol",
  );
  await expect(
    settings.getByLabel("Low model", { exact: true }).locator("option"),
  ).toHaveText(["Sol for this account"]);
  await settings.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(settings.locator("#onboarding-spending-section")).toBeVisible();
  await settings
    .getByRole("button", { name: "Start creating", exact: true })
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
  await expect(page.locator("#provider-badge")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Start voice conversation", exact: true })
    .click();
  await expect(page.locator("#settings-dialog")).toContainText(
    "Add an OpenAI API key to use live voice",
  );
});

async function hostedAccount(context: BrowserContext, planUsage = true) {
  const clientId = "registered-itsalive-fixture";
  let exchanges = 0;
  let models = 0;
  await context.route("**/api/chatgpt/config", (route) => {
    const origin = new URL(route.request().url()).origin;
    return route.fulfill({
      json: {
        configured: true,
        clientId,
        issuer: "https://auth.openai.com",
        authorizationEndpoint: "https://auth.openai.com/api/accounts/authorize",
        redirectUri: `${origin}/auth/chatgpt/callback`,
      },
    });
  });
  await context.route(
    "https://auth.openai.com/api/accounts/authorize?*",
    (route) => {
      const auth = new URL(route.request().url());
      expect(auth.searchParams.get("client_id")).toBe(clientId);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(auth.searchParams.get("scope")).toContain(
        "chatgpt.tokens.use.direct",
      );
      const callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      callback.searchParams.set("code", "fixture-one-use-code");
      return route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(callback.href)})</script>`,
      });
    },
  );
  await context.route("**/api/chatgpt/token", (route) => {
    exchanges++;
    const input = route.request().postDataJSON();
    expect(input.grantType).toBe("authorization_code");
    expect(input.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(input.nonce.length).toBeGreaterThanOrEqual(32);
    return route.fulfill({
      json: {
        clientId,
        accessToken: "browser-only-private-access",
        refreshToken: "browser-only-private-refresh",
        idToken: "signed-identity-fixture",
        subject: "account-fixture",
        email: "browser@example.test",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["openid", ...(planUsage ? ["chatgpt.tokens.use.direct"] : [])],
      },
    });
  });
  await context.route("**/api/chatgpt/models", (route) => {
    models++;
    expect(route.request().headers().authorization).toBe(
      "Bearer browser-only-private-access",
    );
    return route.fulfill({
      json: {
        models: [
          {
            slug: "gpt-6.1-sol",
            display_name: "Account Sol",
            visibility: "list",
          },
        ],
      },
    });
  });
  await context.route("**/api/chatgpt/signout", (route) =>
    route.fulfill({ json: { signedOut: true, revoked: true } }),
  );
  return {
    get exchanges() {
      return exchanges;
    },
    get models() {
      return models;
    },
  };
}

test("hosted public-client login completes in a popup, persists browser credentials and signs out", async ({
  page,
  context,
}) => {
  const account = await hostedAccount(context);
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await page.locator("#welcome-settings").click();
  const settings = page.locator("#settings-dialog");
  await settings.locator("#connection-title").click();
  await settings
    .getByRole("combobox", { name: "Connect with", exact: true })
    .selectOption("chatgpt");
  await settings
    .getByRole("button", { name: "Continue with ChatGPT", exact: true })
    .click();
  await expect(settings.locator("#chatgpt-status")).toContainText(
    "browser@example.test — plan usage enabled",
  );
  expect(account.exchanges).toBe(1);
  expect(account.models).toBeGreaterThan(0);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("itsalive.chatgpt.account")!),
  );
  expect(stored.accessToken).toBe("browser-only-private-access");
  expect(
    await page.evaluate(() => localStorage.getItem("itsalive.chatgpt.pending")),
  ).toBeNull();
  await settings.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(settings.locator("#chatgpt-status")).toContainText(
    "Ready to connect",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("itsalive.chatgpt.account")),
  ).toBeNull();
});

test("hosted identity-only login explains the missing plan grant and never requests models", async ({
  page,
  context,
}) => {
  const account = await hostedAccount(context, false);
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__itsalive));
  await page.locator("#welcome-settings").click();
  const settings = page.locator("#settings-dialog");
  await settings.locator("#connection-title").click();
  await settings
    .getByRole("combobox", { name: "Connect with", exact: true })
    .selectOption("chatgpt");
  await settings
    .getByRole("button", { name: "Continue with ChatGPT", exact: true })
    .click();
  await expect(settings.locator("#chatgpt-status")).toContainText(
    "enable plan usage in ChatGPT",
  );
  await expect(
    settings.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  expect(account.exchanges).toBe(1);
  expect(account.models).toBe(0);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("itsalive.credentials") ?? "{}").openai,
    ),
  ).toBeUndefined();
});

for (const revoked of [true, false]) {
  test(`hosted settings discard stale plan models after ${revoked ? "revocation" : "a narrowed refresh grant"}`, async ({
    page,
    context,
  }) => {
    const account = await hostedAccount(context);
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__itsalive));
    await page.locator("#welcome-settings").click();
    const settings = page.locator("#settings-dialog");
    await settings.locator("#connection-title").click();
    await settings
      .getByRole("combobox", { name: "Connect with", exact: true })
      .selectOption("chatgpt");
    await settings
      .getByRole("button", { name: "Continue with ChatGPT", exact: true })
      .click();
    await expect(settings.locator("#chatgpt-status")).toContainText(
      "plan usage enabled",
    );
    await expect(
      settings.getByLabel("Low model", { exact: true }).locator("option"),
    ).toHaveText(["Account Sol"]);
    await settings
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await page.evaluate(() => {
      const account = JSON.parse(
        localStorage.getItem("itsalive.chatgpt.account")!,
      );
      localStorage.setItem(
        "itsalive.chatgpt.account",
        JSON.stringify({ ...account, expiresAt: 0 }),
      );
    });
    await context.route("**/api/chatgpt/token", (route) => {
      expect(route.request().postDataJSON().grantType).toBe("refresh_token");
      return route.fulfill(
        revoked
          ? {
              status: 400,
              json: {
                error: {
                  code: "invalid_grant",
                  message:
                    "Your ChatGPT sign-in expired. Please connect again.",
                },
              },
            }
          : {
              json: {
                clientId: "registered-itsalive-fixture",
                accessToken: "identity-only-token",
                scopes: ["openid"],
                expiresAt: Date.now() + 3_600_000,
              },
            },
      );
    });
    const requestsBefore = account.models;
    await page.locator("#welcome-settings").click();
    await settings.locator("#connection-title").click();
    await settings
      .getByRole("combobox", { name: "Connect with", exact: true })
      .selectOption("chatgpt");
    await expect(settings.locator("#chatgpt-status")).toContainText(
      revoked ? "sign-in expired" : "no longer grants plan usage",
    );
    await expect(
      settings.getByLabel("Low model", { exact: true }),
    ).toBeDisabled();
    await expect(
      settings.getByLabel("Low model", { exact: true }).locator("option"),
    ).not.toContainText(["Account Sol"]);
    if (revoked) {
      await expect(
        settings.getByRole("button", { name: "Sign out", exact: true }),
      ).toBeHidden();
      expect(
        await page.evaluate(() =>
          localStorage.getItem("itsalive.chatgpt.account"),
        ),
      ).toBeNull();
    } else {
      await expect(
        settings.getByRole("button", { name: "Sign out", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("itsalive.chatgpt.account")!)
              .scopes,
        ),
      ).toEqual(["openid"]);
    }
    expect(account.models).toBe(requestsBefore);
    await settings
      .getByRole("button", { name: "Check connection", exact: true })
      .click();
    await expect(settings.locator("#settings-status")).toContainText(
      "connect your ChatGPT account",
    );
  });
}
