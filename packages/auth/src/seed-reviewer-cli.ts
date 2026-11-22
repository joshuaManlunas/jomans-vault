import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDb } from "@jomans-vault/db";

import { createAuth } from "./index";
import { readReviewerEnvNames, seedReviewerAccount } from "./seed-reviewer";

const ENV_LINE_RE =
  /^(?:export\s+)?(?<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$/u;
const NEWLINE_RE = /\r?\n/u;

const loadFallbackEnv = (envFilePath: string): Record<string, string> => {
  if (!existsSync(envFilePath)) {
    return {};
  }
  const values: Record<string, string> = {};
  const lines = readFileSync(envFilePath, "utf-8").split(NEWLINE_RE);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = ENV_LINE_RE.exec(line);
    const key = match?.groups?.key;
    if (!key) {
      continue;
    }
    let value = (match.groups?.value ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
};

const getEnv = (fallback: Record<string, string>, key: string): string =>
  process.env[key] ?? fallback[key] ?? "";

const main = async () => {
  const repoRoot = path.resolve(
    fileURLToPath(new URL("../../..", import.meta.url))
  );
  const fallback = loadFallbackEnv(path.resolve(repoRoot, "apps/web/.env"));
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
