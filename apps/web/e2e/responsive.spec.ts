import { expect, test } from "@playwright/test";

test("mobile users navigate through the sheet menu", async ({ page }) => {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Mobile User");
  await page.getByLabel("Email").fill(`e2e-m-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/inbox$/);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Needs Reply" }).click();
  await expect(page).toHaveURL(/\/inbox\/needs-reply$/);
  await expect(page.getByRole("heading", { name: "Nothing in Needs Reply" })).toBeVisible();
});
