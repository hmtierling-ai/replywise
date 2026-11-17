import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

test("a mailbox that has not synced yet shows a syncing state", async ({ page }) => {
  const email = await signUp(page);
  await withSeed((seed) => seed.mailbox(email));
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Syncing your inbox…" })).toBeVisible();
});

test("a mailbox that needs reauthorisation says it needs attention", async ({ page }) => {
  const email = await signUp(page);
  await withSeed((seed) => seed.mailbox(email, { status: "needs_reauth" }));
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Your mailbox needs attention" })).toBeVisible();
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

test("opening a thread renders sanitized HTML that cannot run scripts or load trackers", async ({
  page,
}) => {
  const email = await signUp(page);
  await withSeed(async (seed) => {
    const mailbox = await seed.mailbox(email, { lastSyncedAt: new Date() });
    await seed.thread(mailbox, {
      subject: "Hello from Ada",
      snippet: "Hi there",
      html:
        '<p>Hi <b>there</b></p><img src="https://tracker.example/pixel.gif">' +
        '<img src="x" onerror="parent.document.title=\'pwned\'"><script>parent.document.title="pwned"</script>',
    });
  });
  const trackerRequests: string[] = [];
  await page.route("https://tracker.example/**", async (route) => {
    trackerRequests.push(route.request().url());
    await route.abort();
  });

  await page.goto("/inbox");
  await page.getByRole("link", { name: /Hello from Ada/ }).click();
  await expect(page).toHaveURL(/\/thread\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Hello from Ada" })).toBeVisible();
  const frame = page.frameLocator('iframe[title="Email content"]');
  await expect(frame.getByText("Hi there")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.title()).not.toBe("pwned");
  expect(trackerRequests).toEqual([]);
});

test("unknown or foreign thread ids show not found", async ({ page }) => {
  await signUp(page);
  await page.goto("/thread/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("This page could not be found")).toBeVisible();
  await page.goto("/thread/not-a-uuid");
  await expect(page.getByText("This page could not be found")).toBeVisible();
});
