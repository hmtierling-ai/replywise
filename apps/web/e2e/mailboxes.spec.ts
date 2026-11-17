import { expect, test } from "@playwright/test";
import { createDb, mailAccounts } from "@replywise/db";
import { signUp } from "./helpers";

test("the inbox points new users to the mailboxes page", async ({ page }) => {
  await signUp(page);
  await page.getByRole("link", { name: "Connect a mailbox" }).click();
  await expect(page).toHaveURL(/\/settings\/mailboxes$/);
  await expect(page.getByRole("heading", { name: "Mailboxes" })).toBeVisible();
  await expect(page.getByText("No mailboxes connected yet.")).toBeVisible();
});

test("connecting Gmail redirects to Google with PKCE and minimal scopes", async ({ page }) => {
  await signUp(page);
  let authorizeUrl: URL | null = null;
  await page.route("https://accounts.google.com/**", async (route) => {
    authorizeUrl = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Google (stub)</h1>" });
  });

  await page.goto("/settings/mailboxes");
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await expect(page.getByRole("heading", { name: "Google (stub)" })).toBeVisible();

  const url = authorizeUrl as URL | null;
  expect(url?.pathname).toBe("/o/oauth2/v2/auth");
  const params = url?.searchParams;
  expect(params?.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/gmail/callback");
  expect(params?.get("code_challenge_method")).toBe("S256");
  expect(params?.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params?.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(params?.get("access_type")).toBe("offline");
  expect(params?.get("scope")).toBe(
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
  );
});

test("a forged callback state is rejected with a clear message", async ({ page }) => {
  await signUp(page);
  await page.goto("/api/oauth/gmail/callback?code=attacker-code&state=forged-state");
  await expect(page).toHaveURL(/\/settings\/mailboxes\?error=invalid_state$/);
  await expect(
    page.getByRole("alert").filter({ hasText: "invalid or already used" }),
  ).toBeVisible();
});

test("declining consent explains that nothing was connected", async ({ page }) => {
  await signUp(page);
  await page.goto("/api/oauth/gmail/callback?error=access_denied&state=anything");
  await expect(page.getByRole("alert").filter({ hasText: "You declined access" })).toBeVisible();
});

test("the callback requires a signed-in user", async ({ request }) => {
  const response = await request.get("/api/oauth/gmail/callback?code=x&state=y", {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toMatch(/\/sign-in$/);
});

test("a user can see a reconnect prompt and disconnect a mailbox that needs reauthorisation", async ({
  page,
}) => {
  const email = await signUp(page);
  const mailboxEmail = `mailbox-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@gmail.example`;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set for e2e");
  const { db, close } = createDb(databaseUrl, { max: 1 });
  try {
    const user = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, email) });
    if (!user) throw new Error("signed-up user not found in the database");
    const [account] = await db
      .insert(mailAccounts)
      .values({
        userId: user.id,
        provider: "gmail",
        emailAddress: mailboxEmail,
        status: "needs_reauth",
        // Not decryptable: revocation fails and is treated as "not revoked" (manual path).
        tokensCiphertext: Buffer.from("not-a-real-ciphertext"),
      })
      .returning({ id: mailAccounts.id });
    if (!account) throw new Error("failed to seed mail account");

    await page.goto("/settings/mailboxes");
    await expect(page.getByText(mailboxEmail)).toBeVisible();
    await expect(page.getByText("Reconnect needed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();

    await page.getByRole("button", { name: `Disconnect ${mailboxEmail}` }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(`Disconnect ${mailboxEmail}?`);
    await dialog.getByRole("button", { name: "Disconnect" }).click();

    await expect(page).toHaveURL(/\/settings\/mailboxes\?disconnected=gmail&manual=1$/);
    await expect(page.getByRole("status")).toContainText("myaccount.google.com/permissions");
    await expect(page.getByText(mailboxEmail)).toHaveCount(0);
    await expect(page.getByText("No mailboxes connected yet.")).toBeVisible();

    const remaining = await db.query.mailAccounts.findFirst({
      where: (m, { eq }) => eq(m.id, account.id),
    });
    expect(remaining).toBeUndefined();
  } finally {
    await close();
  }
});
