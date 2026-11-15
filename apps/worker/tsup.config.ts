import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", migrate: "../../packages/db/src/bin/migrate.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/^@replywise\//],
  clean: true,
  sourcemap: true,
});
