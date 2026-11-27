import { expect, type Page, test } from "@playwright/test";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

async function seedViews(page: Page) {
  const email = await signUp(page);
  await withSeed(async (seed) => {
    const box = await seed.mailbox(email, { lastSyncedAt: new Date() });
    await seed.thread(box, { subject: "Contract to sign", snippet: "Please sign by Friday" });
    await seed.thread(box, {
      subject: "Weekly sale",
      snippet: "Everything 50% off",
      labels: ["CATEGORY_PROMOTIONS", "INBOX"],
    });
    await seed.thread(box, {
      subject: "Order shipped",
      snippet: "Your order is on its way",
      labels: ["CATEGORY_UPDATES", "INBOX"],
      replied: true,
    });
    await seed.thread(box, {
      subject: "Proposal sent",
      snippet: "Here is the proposal",
      labels: ["SENT"],
    });
  });
}

test("Gmail tab mail moves to Other unless the user replied", async ({ page }) => {
  await seedViews(page);
  await page.goto("/inbox");
  const main = page.getByRole("main");
  await expect(main.getByText("Contract to sign")).toBeVisible();
  await expect(main.getByText("Order shipped")).toBeVisible();
  await expect(main.getByText("Weekly sale")).toHaveCount(0);
  await expect(main.getByText("Proposal sent")).toHaveCount(0);

  const other = page.getByRole("navigation", { name: "Mailbox views" }).getByRole("link", {
    name: "Other",
  });
  await expect(other).toContainText("1");
  // Sent carries no badge by design; All mail counts the two inbox threads.
  await expect(
    page.getByRole("navigation", { name: "Mailbox views" }).getByRole("link", { name: "All mail" }),
  ).toContainText("2");
  await other.click();
  await expect(page).toHaveURL(/\/other$/);
  await expect(main.getByText("Weekly sale")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Gmail tabs" })
    .getByRole("link", { name: "Social" })
    .click();
  await expect(page.getByText("Nothing in Social")).toBeVisible();
});

test("Sent lists the threads the user wrote in", async ({ page }) => {
  await seedViews(page);
  await page.goto("/sent");
  const main = page.getByRole("main");
  await expect(main.getByText("Proposal sent")).toBeVisible();
  await expect(main.getByText("Contract to sign")).toHaveCount(0);
});

test("local search finds threads everywhere and says where they live", async ({ page }) => {
  await seedViews(page);
  await page.goto("/inbox");
  const box = page.getByRole("searchbox", { name: "Search mail" });
  // The shortcut only works once the page has hydrated, so retry until the box has focus.
  await expect(async () => {
    await page.keyboard.press("/");
    await expect(box).toBeFocused({ timeout: 500 });
  }).toPass();
  await page.keyboard.type("sale");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=sale$/);
  const row = page.getByRole("link", { name: /Weekly sale/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Other");

  await page.goto("/search?q=proposal");
  await expect(page.getByRole("link", { name: /Proposal sent/ })).toContainText("Sent");
  await page.goto("/search?q=p");
  await expect(page.getByText("Type at least 2 characters")).toBeVisible();
});
