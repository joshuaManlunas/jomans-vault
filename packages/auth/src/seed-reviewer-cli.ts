import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDb } from "@jomans-vault/db";

import { createAuth } from "./index";
import {
  readEnvFile,
  readReviewerEnvNames,
  seedReviewerAccount,
} from "./seed-reviewer";

const getEnv = (fallback: NodeJS.Dict<string>, key: string): string =>
  process.env[key] ?? fallback[key] ?? "";

const main = async () => {
  const repoRoot = path.resolve(
    fileURLToPath(new URL("../../..", import.meta.url))
  );
  const fallback = readEnvFile(path.resolve(repoRoot, "apps/web/.env"));
  const { emailEnv, passwordEnv } = readReviewerEnvNames(
    path.resolve(repoRoot, "factory/config.json")
  );

  const email = getEnv(fallback, emailEnv);
  const password = getEnv(fallback, passwordEnv);
  const databaseUrl = getEnv(fallback, "DATABASE_URL");
  const authSecret = getEnv(fallback, "BETTER_AUTH_SECRET");
  const authUrl =
    getEnv(fallback, "BETTER_AUTH_URL") || "http://localhost:3001";

  const missing: string[] = [];
  if (!email) {
    missing.push(emailEnv);
  }
  if (!password) {
    missing.push(passwordEnv);
  }
  if (!databaseUrl) {
    missing.push("DATABASE_URL");
  }
  if (!authSecret) {
    missing.push("BETTER_AUTH_SECRET");
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s) for db:seed-reviewer: ${missing.join(", ")}`
    );
  }

  const db = createDb({ DATABASE_URL: databaseUrl });
  try {
    const auth = createAuth(
      {
        BETTER_AUTH_SECRET: authSecret,
        BETTER_AUTH_URL: authUrl,
      },
      db
    );
    const result = await seedReviewerAccount({ auth, email, password });
    process.stdout.write(`Reviewer account ${result.action}.\n`);
  } finally {
    await db.$client.end();
  }
};

await main();
