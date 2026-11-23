import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

// Next.js's route announcer also has role="alert", so scope by text.
const flash = (page: import("@playwright/test").Page, text: string | RegExp) =>
  page.getByRole("alert").filter({ hasText: text });

test("rejects a malformed key without storing it", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings/ai");
  await page.getByLabel("API key", { exact: true }).fill("not-a-key");
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(flash(page, "doesn't look like an Anthropic API key")).toBeVisible();
  await expect(page.getByText("No key yet.")).toBeVisible();
});

test("shows only the hint of a stored key, removes it, and saves the model", async ({ page }) => {
  const email = await signUp(page);
  await withSeed((seed) => seed.aiKey(email, { hint: "wxyz" }));
  await page.goto("/settings/ai");
  await expect(page.getByText("••••wxyz")).toBeVisible();
  await expect(page.getByText("Valid")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("sk-ant-e2e");

  await page.getByLabel(/Claude Haiku 5.5/).check();
  await page.getByRole("button", { name: "Save model" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Classification model updated" }),
  ).toBeVisible();
  await expect(page.getByLabel(/Claude Haiku 5.5/)).toBeChecked();

  await page.getByRole("button", { name: "Remove key" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Key removed" })).toBeVisible();
  await expect(page.getByText("No key yet.")).toBeVisible();
});
