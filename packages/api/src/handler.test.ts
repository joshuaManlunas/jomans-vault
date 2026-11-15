import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createAuth } from "@jomans-vault/auth";
import { MasterKeyError } from "@jomans-vault/crypto";
import { createDb } from "@jomans-vault/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { createVaultApiHandler } from "./handler";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "API tests require DATABASE_URL to create an isolated test database"
  );
}

const databaseName = `jomans_vault_test_${crypto.randomUUID().replaceAll("-", "")}`;
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.pathname = `/${databaseName}`;
const admin = new Pool({ connectionString: databaseUrl });
const db = createDb({ DATABASE_URL: isolatedUrl.toString() });
const baseURL = "http://localhost:5130";
const authSecret = crypto.randomUUID() + crypto.randomUUID();
const auth = createAuth(
  {
    BETTER_AUTH_URL: baseURL,
    BETTER_AUTH_SECRET: authSecret,
  },
  db
);
const masterKey = btoa(
  String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))
);
const handler = createVaultApiHandler({ db, auth, masterKey });
const unknownToken = crypto.randomUUID();
const unknownSignature = createHmac("sha256", authSecret)
  .update(unknownToken)
  .digest("base64");
const unknownCookie = `better-auth.session_token=${encodeURIComponent(`${unknownToken}.${unknownSignature}`)}`;
let created = false;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../db/src/migrations", import.meta.url)
    ),
  });
}, 30_000);

afterAll(async () => {
  try {
    await db.$client.end();
  } finally {
    try {
      if (created) {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  }
});

test("health remains public through the HTTP handler", async () => {
  const response = await handler(new Request(`${baseURL}/api/v1/health`));
  expect(response.status).toBe(200);
  expect(await response.json()).toBe("OK");
});

test.each([
  { name: "missing cookie", cookie: "" },
  {
    name: "unknown session",
    cookie: unknownCookie,
  },
])(
  "private data rejects $name without leaking an auth reason",
  async ({ cookie }) => {
    const response = await handler(
      new Request(`${baseURL}/api/v1/private-data`, {
        headers: cookie ? { cookie } : {},
      })
    );
    const anonymous = await handler(
      new Request(`${baseURL}/api/v1/private-data`)
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual(await anonymous.json());
    expect(body).toMatchObject({
      code: "UNAUTHORIZED",
      message: "Unauthorized",
    });
    for (const field of ["reason", "data", "cause"]) {
      expect(body).not.toHaveProperty(field);
    }
  }
);

test("private data accepts the cookie from real Better Auth sign-up", async () => {
  const email = "vault-handler@example.com";
  const signup = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseURL },
      body: JSON.stringify({
        email,
        password: crypto.randomUUID(),
        name: "Vault Tester",
      }),
    })
  );
  expect(signup.status).toBe(200);
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  expect(cookie).toContain("better-auth.session_token=");
  const response = await handler(
    new Request(`${baseURL}/api/v1/private-data`, { headers: { cookie } })
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    message: "This is private",
    user: { email },
  });
});

test("the generated OpenAPI spec includes both REST operations", async () => {
  const response = await handler(new Request(`${baseURL}/api/v1/spec.json`));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    servers: [{ url: "/api/v1" }],
    paths: {
      "/health": { get: expect.any(Object) },
      "/private-data": { get: expect.any(Object) },
    },
  });
});

test.each([
  { name: "missing", value: undefined },
  { name: "empty", value: "" },
  { name: "invalid base64", value: "not base64!" },
  { name: "noncanonical base64", value: `${"A".repeat(42)}B=` },
  { name: "31 bytes", value: btoa("m".repeat(31)) },
  { name: "33 bytes", value: btoa("m".repeat(33)) },
])(
  "handler construction rejects a $name key without printing it",
  ({ value }) => {
    expect(() => createVaultApiHandler({ db, auth, masterKey: value })).toThrow(
      MasterKeyError
    );
    try {
      createVaultApiHandler({ db, auth, masterKey: value });
    } catch (error) {
      expect(error).toBeInstanceOf(MasterKeyError);
      if (error instanceof MasterKeyError && value) {
        expect(error.message).not.toContain(value);
      }
    }
  }
);
