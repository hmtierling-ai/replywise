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

test("category tabs list classified threads with their reasons", async ({ page }) => {
  const email = await signUp(page);
  const [urgentId] = await withSeed(async (seed) => {
    await seed.aiKey(email);
    const box = await seed.mailbox(email, { lastSyncedAt: new Date() });
    const urgent = await seed.thread(box, { subject: "Server is down", snippet: "Prod outage" });
    const promo = await seed.thread(box, { subject: "50% off", snippet: "Sale" });
    await seed.insight(urgent, {
      category: "urgent",
      urgency: 5,
      importance: 5,
      reasons: ["Production outage reported."],
    });
    await seed.insight(promo, {
      category: "low_priority",
      urgency: 1,
      importance: 1,
      reasons: ["Marketing email."],
    });
    return [urgent, promo];
  });

  await page.goto("/inbox/urgent");
  await expect(page.getByText("Server is down")).toBeVisible();
  await expect(page.getByText("Production outage reported.")).toBeVisible();
  await expect(page.getByText("50% off")).toHaveCount(0);

  await page.goto("/inbox");
  await expect(page.locator('[data-category="low_priority"]')).toHaveCount(1);

  await page.goto(`/thread/${urgentId}`);
  const panel = page.getByRole("region", { name: "Why Replywise sorted this thread" });
  await expect(panel).toContainText("Urgency 5/5 · Importance 5/5");
  await expect(panel).toContainText("Production outage reported.");
});

test("inbox asks for a key when none is stored", async ({ page }) => {
  const email = await signUp(page);
  await withSeed((seed) => seed.mailbox(email, { lastSyncedAt: new Date() }));
  await page.goto("/inbox/needs-reply");
  await expect(page.getByRole("link", { name: "Add key" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nothing in Needs Reply" })).toBeVisible();
});
