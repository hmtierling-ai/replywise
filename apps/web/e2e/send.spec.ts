import { expect, type Page, test } from "@playwright/test";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

// Several role=status elements can be visible at once, and Next's route announcer is role=alert,
// so always filter by text.
const status = (scope: Page | ReturnType<Page["getByRole"]>, text: string | RegExp) =>
  scope.getByRole("status").filter({ hasText: text });
const alert = (scope: Page | ReturnType<Page["getByRole"]>, text: string | RegExp) =>
  scope.getByRole("alert").filter({ hasText: text });

async function setup(page: Page, provider: "gmail" | "outlook" = "gmail") {
  const email = await signUp(page);
  const threadId = await withSeed(async (seed) => {
    await seed.aiKey(email);
    const box = await seed.mailbox(email, { provider, lastSyncedAt: new Date() });
    return seed.thread(box, {
      subject: "Contract to sign",
      snippet: "Please sign by Friday",
      text: "Hi, please sign the contract by Friday.",
    });
  });
  return { email, threadId };
}

test("Send asks for confirmation, and Undo returns the draft to editing", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, { status: "generated", body: "Hi Ada,\n\nSigned." }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await composer.getByRole("button", { name: "Send…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("ada@example.com");
  await expect(dialog).toContainText("Re: Contract to sign");
  await expect(dialog).toContainText("Signed.");
  await dialog.getByRole("button", { name: "Send now" }).click();

  await expect(status(composer, /Sending in/)).toBeVisible();
  await expect(composer.getByRole("textbox", { name: "Reply draft" })).toHaveCount(0);
  await composer.getByRole("button", { name: "Undo" }).click();

  const body = composer.getByRole("textbox", { name: "Reply draft" });
  await expect(body).toHaveValue("Hi Ada,\n\nSigned.");
  await body.fill("Hi Ada,\n\nSigned and attached.");
  await composer.getByRole("button", { name: "Save edits" }).click();
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Reply" }).getByRole("textbox", { name: "Reply draft" }),
  ).toHaveValue("Hi Ada,\n\nSigned and attached.");
});

test("unsaved edits must be saved before sending", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, { status: "generated", body: "Hi Ada,\n\nSigned." }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await composer.getByRole("textbox", { name: "Reply draft" }).fill("Changed");
  await composer.getByRole("button", { name: "Send…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(alert(dialog, "unsaved edits")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send now" })).toHaveCount(0);
});

test("a sent reply is locked and links to Gmail", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, {
      status: "sent",
      body: "Hi Ada,\n\nSigned.",
      providerDraftId: "r-1",
      sentAt: new Date(),
    }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await expect(status(composer, "Sent ✓")).toBeVisible();
  await expect(composer.getByRole("link", { name: "Open in Gmail" })).toBeVisible();
  await expect(composer.getByRole("textbox", { name: "Reply draft" })).toHaveCount(0);
  await expect(composer.getByRole("button", { name: "Send…" })).toHaveCount(0);
});

test("an unconfirmed send explains itself and Edit reopens the draft", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, {
      status: "send_failed",
      body: "Hi Ada,\n\nSigned.",
      error: "send_unconfirmed",
    }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await expect(alert(composer, "may or may not have gone out")).toBeVisible();
  await expect(composer.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await composer.getByRole("button", { name: "Edit" }).click();
  await expect(composer.getByRole("textbox", { name: "Reply draft" })).toHaveValue(
    "Hi Ada,\n\nSigned.",
  );
});

test("Outlook drafts offer no Send", async ({ page }) => {
  const { email, threadId } = await setup(page, "outlook");
  await withSeed((seed) =>
    seed.draft(email, threadId, { status: "generated", body: "Hi Ada,\n\nSigned." }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await expect(composer.getByRole("textbox", { name: "Reply draft" })).toBeVisible();
  await expect(composer.getByRole("button", { name: "Send…" })).toHaveCount(0);
});
