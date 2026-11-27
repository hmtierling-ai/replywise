import { expect, test } from "@playwright/test";
import { FAKE_GMAIL_PORT, startFakeGmail } from "./fake-gmail";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

let fake: Awaited<ReturnType<typeof startFakeGmail>>;

test.beforeAll(async () => {
  fake = await startFakeGmail(FAKE_GMAIL_PORT, [
    {
      id: "g1old",
      subject: "Old invoice 2024",
      from: "Billing <billing@vendor.example>",
      snippet: "Your invoice is attached",
      body: "Invoice total: 120 EUR",
      date: new Date("2024-03-01T10:00:00Z"),
    },
  ]);
});
test.afterAll(async () => fake.close());

test("Search all of Gmail finds an old thread, imports it and then links to it", async ({
  page,
}) => {
  const email = await signUp(page);
  await withSeed(async (seed) => {
    await seed.gmailMailbox(email);
  });
  await page.goto("/search?q=invoice");
  await expect(page.getByText("No matches in Replywise")).toBeVisible();
  await page.getByRole("button", { name: "Search all of Gmail" }).click();
  const results = page.getByRole("list", { name: "Gmail results" });
  await expect(results).toContainText("Old invoice 2024");
  await results.getByRole("button", { name: "Import" }).click();

  await expect(page).toHaveURL(/\/thread\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Old invoice 2024" })).toBeVisible();
  await expect(page.getByText("Invoice total: 120 EUR")).toBeVisible();

  await page.goto("/search?q=invoice");
  await expect(page.getByRole("link", { name: /Old invoice 2024/ })).toBeVisible();
  await page.getByRole("button", { name: "Search all of Gmail" }).click();
  await expect(
    page.getByRole("list", { name: "Gmail results" }).getByRole("link", { name: "Open" }),
  ).toBeVisible();
  expect(fake.queries).toContain("invoice");
});
