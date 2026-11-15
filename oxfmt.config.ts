import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "factory/**",
    ".claude/**",
    "packages/db/src/schema/auth.ts",
    "packages/db/src/migrations/**",
  ],
});
