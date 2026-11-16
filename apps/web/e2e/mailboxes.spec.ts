import { expect, type Page, test } from "@playwright/test";

async function signUp(page: Page) {
  // Better Auth rate-limits sign-ups per client IP (about 3 per 10s). Parallel workers share
  // 127.0.0.1, so give each test its own forwarded address instead of weakening the limiter.
  const octet = () => Math.floor(Math.random() * 250) + 1;
  await page
    .context()
    .setExtraHTTPHeaders({ "x-forwarded-for": `10.${octet()}.${octet()}.${octet()}` });
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Mailbox Tester");
  await page
    .getByLabel("Email")
    .fill(`e2e-mb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
}

test("the inbox points new users to the mailboxes page", async ({ page }) => {
  await signUp(page);
  await page.getByRole("link", { name: "Connect a mailbox" }).click();
  await expect(page).toHaveURL(/\/settings\/mailboxes$/);
  await expect(page.getByRole("heading", { name: "Mailboxes" })).toBeVisible();
  await expect(page.getByText("No mailboxes connected yet.")).toBeVisible();
});

test("connecting Gmail redirects to Google with PKCE and minimal scopes", async ({ page }) => {
  await signUp(page);
  let authorizeUrl: URL | null = null;
  await page.route("https://accounts.google.com/**", async (route) => {
    authorizeUrl = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Google (stub)</h1>" });
  });

  await page.goto("/settings/mailboxes");
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await expect(page.getByRole("heading", { name: "Google (stub)" })).toBeVisible();

  const url = authorizeUrl as URL | null;
  expect(url?.pathname).toBe("/o/oauth2/v2/auth");
  const params = url?.searchParams;
  expect(params?.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/gmail/callback");
  expect(params?.get("code_challenge_method")).toBe("S256");
  expect(params?.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params?.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params?.get("access_type")).toBe("offline");
  expect(params?.get("scope")).toBe(
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
  );
});

test("a forged callback state is rejected with a clear message", async ({ page }) => {
  await signUp(page);
  await page.goto("/api/oauth/gmail/callback?code=attacker-code&state=forged-state");
  await expect(page).toHaveURL(/\/settings\/mailboxes\?error=invalid_state$/);
  await expect(
    page.getByRole("alert").filter({ hasText: "invalid or already used" }),
  ).toBeVisible();
});

test("declining consent explains that nothing was connected", async ({ page }) => {
  await signUp(page);
  await page.goto("/api/oauth/gmail/callback?error=access_denied&state=anything");
  await expect(page.getByRole("alert").filter({ hasText: "You declined access" })).toBeVisible();
});

test("the callback requires a signed-in user", async ({ request }) => {
  const response = await request.get("/api/oauth/gmail/callback?code=x&state=y", {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toMatch(/\/sign-in$/);
});
