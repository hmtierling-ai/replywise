import { expect, type Page, test } from "@playwright/test";
import { signUp } from "./helpers";
import { withSeed } from "./seed";

// Several role=status elements can be visible at once, and Next's route announcer is role=alert,
// so always filter by text.
const status = (scope: Page | ReturnType<Page["getByRole"]>, text: string | RegExp) =>
  scope.getByRole("status").filter({ hasText: text });
const alert = (scope: Page | ReturnType<Page["getByRole"]>, text: string | RegExp) =>
  scope.getByRole("alert").filter({ hasText: text });

async function setup(page: Page, options: { key?: boolean } = {}) {
  const email = await signUp(page);
  const threadId = await withSeed(async (seed) => {
    if (options.key ?? true) await seed.aiKey(email);
    const box = await seed.mailbox(email, { lastSyncedAt: new Date() });
    return seed.thread(box, {
      subject: "Contract to sign",
      snippet: "Please sign by Friday",
      text: "Hi, please sign the contract by Friday.",
    });
  });
  return { email, threadId };
}

test("a ready summary renders as text and a failed one shows its fixed copy", async ({ page }) => {
  const { threadId } = await setup(page);
  await withSeed((seed) =>
    seed.summary(threadId, { status: "ready", text: "Ada asks you to sign by Friday." }),
  );
  await page.goto(`/thread/${threadId}`);
  const panel = page.getByRole("region", { name: "Thread summary" });
  await expect(panel).toContainText("Ada asks you to sign by Friday.");

  await withSeed((seed) => seed.summary(threadId, { status: "failed", error: "ai_unavailable" }));
  await page.reload();
  await expect(alert(panel, "Anthropic is busy or unreachable")).toBeVisible();
});

test("clicking Summarize shows the pending state", async ({ page }) => {
  const { threadId } = await setup(page);
  await page.goto(`/thread/${threadId}`);
  const panel = page.getByRole("region", { name: "Thread summary" });
  await panel.getByRole("button", { name: "Summarize", exact: true }).click();
  await expect(status(panel, "Summarizing")).toBeVisible();
});

test("a generated draft is editable and the edit persists", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, { status: "generated", body: "Hi Ada,\n\nYes." }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  const body = composer.getByRole("textbox", { name: "Reply draft" });
  await expect(body).toHaveValue("Hi Ada,\n\nYes.");

  await body.fill("Hi Ada,\n\nYes, signed.");
  await composer.getByRole("button", { name: "Save edits" }).click();
  await page.waitForLoadState("networkidle");
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Reply" }).getByRole("textbox", { name: "Reply draft" }),
  ).toHaveValue("Hi Ada,\n\nYes, signed.");
});

test("Save to Gmail shows the pending state", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, { status: "generated", body: "Hi Ada,\n\nYes." }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await composer.getByRole("button", { name: "Save to Gmail" }).click();
  await expect(status(composer, "Saving to Gmail")).toBeVisible();
});

test("a saved draft shows when it was saved and offers to update it", async ({ page }) => {
  const { email, threadId } = await setup(page);
  await withSeed((seed) =>
    seed.draft(email, threadId, {
      status: "saved",
      body: "Hi Ada,\n\nYes.",
      providerDraftId: "r-1",
      savedAt: new Date(),
    }),
  );
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await expect(composer.getByText("Saved to Gmail")).toBeVisible();
  await expect(composer.getByRole("button", { name: "Update Gmail draft" })).toBeVisible();
  await expect(composer.getByRole("button", { name: "Save to Gmail", exact: true })).toHaveCount(0);
  await expect(composer.getByRole("link", { name: "Open Gmail drafts" })).toBeVisible();
});

test("Generate reply creates a pending draft", async ({ page }) => {
  const { threadId } = await setup(page);
  await page.goto(`/thread/${threadId}`);
  const composer = page.getByRole("region", { name: "Reply" });
  await composer.getByLabel("Tone").selectOption({ label: "Concise" });
  await composer.getByLabel("Instructions (optional)").fill("Suggest Thursday afternoon");
  await composer.getByRole("button", { name: "Generate reply" }).click();
  await expect(status(composer, "Writing a reply")).toBeVisible();
});

test("without a key the composer and summary link to settings", async ({ page }) => {
  const { threadId } = await setup(page, { key: false });
  await page.goto(`/thread/${threadId}`);
  const summary = page.getByRole("region", { name: "Thread summary" });
  const composer = page.getByRole("region", { name: "Reply" });
  await expect(summary.getByRole("link", { name: "Add your Anthropic key" })).toBeVisible();
  await expect(composer.getByRole("link", { name: "Add your Anthropic key" })).toBeVisible();
  await expect(summary.getByRole("button", { name: "Summarize" })).toHaveCount(0);
  await expect(composer.getByRole("button", { name: "Generate reply" })).toHaveCount(0);
});

test("writing preferences persist", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings/ai");
  await page.getByRole("radio", { name: /Friendly/ }).check();
  await page.getByRole("radio", { name: "Reply model: Claude Haiku 5.5" }).check();
  await page.getByLabel("Signature").fill("Cheers,\nAda");
  await page.getByRole("button", { name: "Save writing preferences" }).click();
  await page.waitForLoadState("networkidle");

  await page.reload();
  await expect(page.getByRole("radio", { name: /Friendly/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Reply model: Claude Haiku 5.5" })).toBeChecked();
  await expect(page.getByLabel("Signature")).toHaveValue("Cheers,\nAda");
});

test("the auto-draft toggle persists", async ({ page }) => {
  const email = await signUp(page);
  const mailboxEmail = `auto-${Date.now()}@gmail.example`;
  await withSeed((seed) => seed.mailbox(email, { emailAddress: mailboxEmail }));
  await page.goto("/settings/mailboxes");
  const toggle = page.getByRole("checkbox", { name: `Auto-draft replies for ${mailboxEmail}` });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole("button", { name: `Save auto-draft setting for ${mailboxEmail}` }).click();
  await page.waitForLoadState("networkidle");

  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: `Auto-draft replies for ${mailboxEmail}` }),
  ).toBeChecked();
});
