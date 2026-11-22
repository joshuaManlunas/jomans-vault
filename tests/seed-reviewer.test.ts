import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAuth } from "../packages/auth/src/index";
import { createDb } from "../packages/db/src/index";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Reviewer seed test requires DATABASE_URL to create an isolated test database"
  );
}

const databaseName = `jomans_vault_seed_${crypto.randomUUID().replaceAll("-", "")}`;
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.pathname = `/${databaseName}`;
const adminDb = createDb({ DATABASE_URL: databaseUrl });
const db = createDb({ DATABASE_URL: isolatedUrl.toString() });
const authSecret = crypto.randomUUID() + crypto.randomUUID();
const authUrl = "http://localhost:5140";
const auth = createAuth(
  {
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_URL: authUrl,
  },
  db
);
let created = false;

const runCommand = (args: string[], extraEnv: Record<string, string>) => {
  const result = Bun.spawnSync(args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString() || result.stdout.toString()}`
    );
  }
  return result.stdout.toString();
};

beforeAll(async () => {
  await adminDb.$client.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  runCommand(["bun", "run", "--cwd", "packages/db", "db:migrate"], {
    DATABASE_URL: isolatedUrl.toString(),
  });
}, 30_000);

afterAll(async () => {
  try {
    await db.$client.end();
  } finally {
    try {
      if (created) {
        await adminDb.$client.query(`DROP DATABASE "${databaseName}"`);
      }
    } finally {
      await adminDb.$client.end();
    }
  }
});

test("db:seed-reviewer is idempotent and creates a working Better Auth account", async () => {
  const email = "reviewer-test@example.invalid";
  const initialPassword = "initial-password-1234";
  const rotatedPassword = "rotated-password-5678";
  const baseEnv = {
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_URL: authUrl,
    DATABASE_URL: isolatedUrl.toString(),
  };

  runCommand(["bun", "run", "db:seed-reviewer"], {
    ...baseEnv,
    FACTORY_REVIEW_EMAIL: email,
    FACTORY_REVIEW_PASSWORD: initialPassword,
  });
  runCommand(["bun", "run", "db:seed-reviewer"], {
    ...baseEnv,
    FACTORY_REVIEW_EMAIL: email.toUpperCase(),
    FACTORY_REVIEW_PASSWORD: rotatedPassword,
  });

  const rows = await db.$client.query<{ id: string; email: string }>(
    'SELECT id, email FROM "user" WHERE email = $1',
    [email]
  );
  expect(rows.rows).toHaveLength(1);

  const signIn = await auth.api.signInEmail({
    body: {
      email,
      password: rotatedPassword,
    },
  });
  expect(signIn.user.id).toBe(rows.rows[0]?.id ?? "");
  expect(signIn.user.email).toBe(email);
});
