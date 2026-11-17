import { expect, type Page } from "@playwright/test";

export const PASSWORD = "correct-horse-battery";

export const uniqueEmail = (prefix = "e2e") =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/**
 * Better Auth rate-limits sign-ups per client IP (about 3 per 10s). Parallel workers share
 * 127.0.0.1, so each test context gets its own forwarded address instead of weakening the limiter.
 */
export async function assignUniqueClientIp(page: Page) {
  const octet = () => Math.floor(Math.random() * 250) + 1;
  await page
    .context()
    .setExtraHTTPHeaders({ "x-forwarded-for": `10.${octet()}.${octet()}.${octet()}` });
}

export async function signUp(page: Page, options: { name?: string; email?: string } = {}) {
  const email = options.email ?? uniqueEmail();
  await assignUniqueClientIp(page);
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(options.name ?? "Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  return email;
}
