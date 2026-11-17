import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

test("a mailbox that has not synced yet shows a syncing state", async ({ page }) => {
  const email = await signUp(page);
  await withSeed((seed) => seed.mailbox(email));
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Syncing your inbox…" })).toBeVisible();
});

test("synced threads are listed newest first with unread emphasis", async ({ page }) => {
  const email = await signUp(page);
  await withSeed(async (seed) => {
    const mailbox = await seed.mailbox(email, { lastSyncedAt: new Date() });
    await seed.thread(mailbox, {
      subject: "Quarterly numbers",
      snippet: "See attached",
      at: new Date(Date.now() - 3_600_000),
    });
    await seed.thread(mailbox, {
      subject: "Lunch tomorrow?",
      snippet: "Noon works",
      unread: true,
      at: new Date(Date.now() - 60_000),
    });
  });
  await page.goto("/inbox");
  const rows = page.getByRole("link", { name: /Lunch tomorrow\?|Quarterly numbers/ });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Lunch tomorrow?");
  await expect(rows.first()).toHaveAttribute("data-unread", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-unread", "false");

  await page.goto("/settings/mailboxes");
  await expect(page.getByText("Synced just now")).toBeVisible();
});
