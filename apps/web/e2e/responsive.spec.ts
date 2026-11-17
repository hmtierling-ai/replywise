import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

test("mobile users navigate through the sheet menu", async ({ page }) => {
  await signUp(page, { name: "Mobile User" });

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Needs Reply" }).click();
  await expect(page).toHaveURL(/\/inbox\/needs-reply$/);
  await expect(page.getByRole("heading", { name: "Nothing in Needs Reply" })).toBeVisible();
});
