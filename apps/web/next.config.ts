import path from "node:path";
import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  transpilePackages: [
    "@replywise/ai",
    "@replywise/core",
    "@replywise/config",
    "@replywise/crypto",
    "@replywise/db",
    "@replywise/mail",
    "@replywise/mailbox",
    "@replywise/observability",
    "@replywise/sync",
  ],
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV === "production") }];
  },
};

export default nextConfig;
