import { isMailProviderId } from "@replywise/core";
import { ConnectError, completeConnect, MAILBOXES_PATH } from "@replywise/mailbox";
import { type NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getMailboxDeps, oauthCallbackUrl, requestContext } from "@/lib/mailbox";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/oauth/[provider]/callback">,
) {
  const back = (params: Record<string, string>) =>
    NextResponse.redirect(new URL(`${MAILBOXES_PATH}?${new URLSearchParams(params)}`, request.url));

  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/sign-in", request.url));

  const { provider } = await ctx.params;
  if (!isMailProviderId(provider)) return back({ error: "not_configured" });

  const query = request.nextUrl.searchParams;
  const providerError = query.get("error");
  if (providerError) {
    return back({ error: providerError === "access_denied" ? "access_denied" : "provider_error" });
  }
  const code = query.get("code");
  const state = query.get("state");
  if (!code || !state) return back({ error: "invalid_state" });

  try {
    await completeConnect(getMailboxDeps(), {
      userId: session.user.id,
      provider,
      code,
      state,
      redirectUri: oauthCallbackUrl(provider),
      context: requestContext(request.headers),
    });
    return back({ connected: provider });
  } catch (error) {
    if (error instanceof ConnectError) return back({ error: error.reason });
    console.error("mailbox connect failed", error instanceof Error ? error.name : "unknown");
    return back({ error: "provider_error" });
  }
}
