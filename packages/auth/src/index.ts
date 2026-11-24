import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { Database } from "@jomans-vault/db";
import * as schema from "@jomans-vault/db/schema/auth";
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";

export interface AuthConfig {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
}

export const createAuth = (env: AuthConfig, database: Database) =>
  betterAuth({
    database: drizzleAdapter(database, {
      provider: "pg",
      schema,
    }),
    trustedOrigins: [env.BETTER_AUTH_URL],
    emailAndPassword: { enabled: true },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    disabledPaths: [
      "/api-key/create",
      "/api-key/list",
      "/api-key/get",
      "/api-key/update",
      "/api-key/delete",
    ],
    plugins: [
      apiKey({
        defaultPrefix: "jv_",
        enableMetadata: true,
        permissions: { defaultPermissions: { secrets: ["read"] } },
        rateLimit: { enabled: false },
        enableSessionForAPIKeys: false,
      }),
      tanstackStartCookies(),
    ],
  });

export type Auth = ReturnType<typeof createAuth>;

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
