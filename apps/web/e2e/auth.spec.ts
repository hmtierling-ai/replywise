import { expect, type Page, test } from "@playwright/test";

const uniqueEmail = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const PASSWORD = "correct-horse-battery";

async function signUp(page: Page, email: string) {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
}

test("unauthenticated visitors are redirected to sign-in", async ({ page }) => {
  await page.goto("/inbox/urgent");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("a new user signs up, sees the app shell, signs out and signs back in", async ({ page }) => {
  const email = uniqueEmail();
  await signUp(page, email);
  await expect(page.getByRole("link", { name: "Urgent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No mailboxes connected" })).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test("a wrong password shows an error and stays on sign-in", async ({ page }) => {
  const email = uniqueEmail();
  await signUp(page, email);
  await page.context().clearCookies();

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("definitely-not-it");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("a forged session cookie does not grant access", async ({ page, context }) => {
  await context.addCookies([
    { name: "better-auth.session_token", value: "forged", url: "http://localhost:3000" },
  ]);
  await page.goto("/inbox");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("responses carry security headers and unknown categories are real 404s", async ({
  request,
}) => {
  const response = await request.get("/sign-in");
  const headers = response.headers();
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-powered-by"]).toBeUndefined();

  const unknown = await request.get("/inbox/bogus", {
    headers: { cookie: "better-auth.session_token=forged" },
    maxRedirects: 0,
  });
  expect(unknown.status()).toBe(404);
});
