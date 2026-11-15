import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { routeDecision } from "@/lib/route-guard";

export function proxy(request: NextRequest) {
  const decision = routeDecision(request.nextUrl.pathname, getSessionCookie(request) !== null);
  switch (decision.type) {
    case "redirect":
      return NextResponse.redirect(new URL(decision.to, request.url));
    case "notFound":
      return NextResponse.rewrite(new URL("/not-found-page", request.url), { status: 404 });
    default:
      return NextResponse.next();
  }
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
