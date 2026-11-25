import {
  afterAll,
  beforeAll,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createAuth } from "@jomans-vault/auth";
import { parseMasterKey } from "@jomans-vault/crypto";
import { createDb } from "@jomans-vault/db";
import { apikey } from "@jomans-vault/db/schema/auth";
import { auditEvent } from "@jomans-vault/db/schema/vault";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as z from "zod";

import { createContext } from "./context";
import { createVaultApiHandler } from "./handler";
import { appRouter } from "./routers/index";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "API tests require DATABASE_URL to create an isolated test database"
  );
}
const databaseName = `jomans_vault_key_routes_${crypto.randomUUID().replaceAll("-", "")}`;
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.pathname = `/${databaseName}`;
const admin = new Pool({ connectionString: databaseUrl });
const db = createDb({ DATABASE_URL: isolatedUrl.toString() });
const baseURL = "http://localhost:5140";
const auth = createAuth(
  {
    BETTER_AUTH_URL: baseURL,
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  },
  db
);
const masterKey = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32))
).toString("base64");
const handler = createVaultApiHandler({ db, auth, masterKey });
const scope = { projects: { "my-app": ["development"] } };
const listPath = "/projects/my-app/envs/development/secrets";
const valuePath = `${listPath}/TOKEN`;
const exportPath = "/projects/my-app/envs/development/export";
const requestMetadata = {
  "User-Agent": "API key management test",
  "X-Forwarded-For": "192.0.2.10, 192.0.2.11",
};
const summarySchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    scope: z.object({ projects: z.record(z.string(), z.array(z.string())) }),
    permissions: z.array(z.string()),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    createdAt: z.string(),
    revoked: z.boolean(),
  })
  .strict();
const createdSchema = summarySchema.extend({ key: z.string() });
type CreatedKey = z.infer<typeof createdSchema>;
interface TestUser {
  cookie: string;
  id: string;
}
let userA: TestUser;
let userB: TestUser;
let created = false;

const signupUser = async (email: string): Promise<TestUser> => {
  const response = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseURL },
      body: JSON.stringify({
        email,
        password: crypto.randomUUID(),
        name: "Key Tester",
      }),
    })
  );
  expect(response.status).toBe(200);
  const body = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await response.json());
  return {
    id: body.user.id,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
};
const request = async (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
) =>
  await handler(
    new Request(`${baseURL}/api/v1${path}`, {
      method,
      headers: {
        ...requestMetadata,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
const createKey = async (
  input: Record<string, unknown> = {},
  user?: TestUser
): Promise<CreatedKey> => {
  const response = await request(
    "POST",
    "/api-keys",
    { cookie: (user ?? userA).cookie },
    {
      name: "Test key",
      scope,
      ...input,
    }
  );
  expect(response.status).toBe(201);
  return createdSchema.parse(await response.json());
};
const listKeys = async (user = userA) => {
  const response = await request("GET", "/api-keys", { cookie: user.cookie });
  expect(response.status).toBe(200);
  return z.array(summarySchema).parse(await response.json());
};
const revoke = async (id: string, user = userA) =>
  await request("POST", `/api-keys/${id}/revoke`, { cookie: user.cookie });
const keyRequest = async (key: string, path = listPath) =>
  await request("GET", path, { "x-api-key": key });
const snapshot = async () => ({
  keys: await db.select().from(apikey).orderBy(apikey.id),
  audit: await db.select().from(auditEvent).orderBy(auditEvent.id),
});
const expectError = async (
  response: Response,
  status: number,
  code: string
) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const body = z.record(z.string(), z.unknown()).parse(await response.json());
  expect(body).toMatchObject({ status, code });
  if (status !== 400) {
    expect(body).not.toHaveProperty("data");
  }
  return body;
};

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../db/src/migrations", import.meta.url)
    ),
  });
  userA = await signupUser("route-key-owner@example.com");
  userB = await signupUser("route-key-other@example.com");
  await Promise.all(
    [userA, userB].map(async (user) => {
      const projectResponse = await request(
        "POST",
        "/projects",
        { cookie: user.cookie },
        { slug: user === userA ? "my-app" : "other-app", name: "App" }
      );
      expect(projectResponse.status).toBe(201);
    })
  );
  const otherEnvironmentResponse = await request(
    "POST",
    "/projects/other-app/envs",
    { cookie: userB.cookie },
    { slug: "development" }
  );
  expect(otherEnvironmentResponse.status).toBe(201);
  const environmentResponse = await request(
    "POST",
    "/projects/my-app/envs",
    { cookie: userA.cookie },
    { slug: "development" }
  );
  expect(environmentResponse.status).toBe(201);
  const secretResponse = await request(
    "PUT",
    valuePath,
    { cookie: userA.cookie },
    { value: "test-secret-value" }
  );
  expect(secretResponse.status).toBe(200);
}, 30_000);
afterAll(async () => {
  try {
    await db.$client.end();
  } finally {
    try {
      if (created) {
        await admin.query(`DROP DATABASE "${databaseName}"`);
      }
    } finally {
      await admin.end();
    }
  }
});

test("create returns a working reveal key once and summaries never expose key material", async () => {
  const key = await createKey({
    name: "  Reveal key  ",
    permissions: ["reveal"],
  });
  expect(key).toMatchObject({
    name: "Reveal key",
    scope,
    permissions: ["reveal"],
    expiresAt: null,
    lastUsedAt: null,
    revoked: false,
  });
  expect(key.key.startsWith("jv_")).toBe(true);
  const secretResponse = await keyRequest(key.key, valuePath);
  expect(secretResponse.status).toBe(200);
  const [stored] = await db.select().from(apikey).where(eq(apikey.id, key.id));
  expect(stored).toBeDefined();
  const listed = await listKeys();
  const revokeResponse = await revoke(key.id);
  const revoked = summarySchema.parse(await revokeResponse.json());
  for (const result of [listed, revoked]) {
    for (const material of [key.key, stored?.key, stored?.start]) {
      expect(material).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain(material ?? "missing");
    }
  }
});

test.each([{ permissions: undefined }, { permissions: [] }])(
  "permissions %j defaults explicitly to read",
  async ({ permissions }) => {
    const key = await createKey(
      permissions === undefined ? {} : { permissions }
    );
    const listed = await listKeys();
    expect(listed.find((row) => row.id === key.id)?.permissions).toEqual([
      "read",
    ]);
    const secretResponse = await keyRequest(key.key);
    expect(secretResponse.status).toBe(200);
    await expectError(await keyRequest(key.key, valuePath), 403, "FORBIDDEN");
    await expectError(await keyRequest(key.key, exportPath), 403, "FORBIDDEN");
  }
);

test("all five permissions are preserved and duplicate scope entries and permissions collapse", async () => {
  const permissions = ["read", "reveal", "inject", "write", "delete"];
  const key = await createKey({
    permissions: [...permissions, "read"],
    scope: { projects: { "my-app": ["development", "development"] } },
  });
  expect(key.scope).toEqual(scope);
  const listed = await listKeys();
  expect(listed.find((row) => row.id === key.id)?.permissions).toEqual(
    permissions
  );
});

const invalidInputs = [
  { scope: { projects: { "other-app": ["development"] } } },
  { scope: { projects: { absent: ["development"] } } },
  { scope: { projects: { "my-app": ["missing"] } } },
  { permissions: ["read", "admin"] },
  { scope: { projects: {} } },
  { scope: { projects: { "my-app": [] } } },
  { name: undefined },
  { name: "  " },
  { scope: null },
  { scope: { projects: { "Bad Slug": ["development"] } } },
  { scope: { projects: { "my-app": ["Bad Slug"] } } },
  { expiresIn: 86_400.5 },
];
test.each(invalidInputs)(
  "invalid create %j changes no rows or audit events",
  async (input) => {
    const before = await snapshot();
    await expectError(
      await request(
        "POST",
        "/api-keys",
        { cookie: userA.cookie },
        { name: "Invalid", scope, ...input }
      ),
      400,
      "BAD_REQUEST"
    );
    expect(await snapshot()).toEqual(before);
  }
);
test("unowned and nonexistent project bodies are identical", async () => {
  const bodies = await Promise.all(
    ["other-app", "absent"].map(
      async (projectSlug) =>
        await expectError(
          await request(
            "POST",
            "/api-keys",
            { cookie: userA.cookie },
            {
              name: "Invalid scope",
              scope: { projects: { [projectSlug]: ["development"] } },
            }
          ),
          400,
          "BAD_REQUEST"
        )
    )
  );
  expect(bodies[0]).toEqual(bodies[1]);
});

test.each([
  { name: "x".repeat(32), status: 201 },
  { name: "x".repeat(33), status: 400 },
  { expiresIn: 86_399, status: 400 },
  { expiresIn: 31_536_001, status: 400 },
  { expiresIn: 86_400, status: 201 },
  { expiresIn: 31_536_000, status: 201 },
])("name and expiry boundary %j", async ({ status, ...input }) => {
  const before = await snapshot();
  const now = Date.now();
  const response = await request(
    "POST",
    "/api-keys",
    { cookie: userA.cookie },
    { name: "Boundary", scope, ...input }
  );
  expect(response.status).toBe(status);
  if (status === 400) {
    expect(await snapshot()).toEqual(before);
    return;
  }
  const key = createdSchema.parse(await response.json());
  const summaries = await listKeys();
  const listed = summaries.find((row) => row.id === key.id);
  expect(listed).toBeDefined();
  if (input.expiresIn !== undefined) {
    expect(
      Math.abs(
        Date.parse(listed?.expiresAt ?? "") - now - input.expiresIn * 1000
      )
    ).toBeLessThan(5000);
  }
});

test("list contains exactly the owner's summaries, newest first", async () => {
  const other = await createKey(
    { scope: { projects: { "other-app": ["development"] } } },
    userB
  );
  const listed = await listKeys();
  const rows = await db
    .select({ id: apikey.id, createdAt: apikey.createdAt })
    .from(apikey)
    .where(eq(apikey.referenceId, userA.id));
  expect(listed.map((row) => row.id).toSorted()).toEqual(
    rows.map((row) => row.id).toSorted()
  );
  expect(listed.some((row) => row.id === other.id)).toBe(false);
  const dates = listed.map((row) => Date.parse(row.createdAt));
  expect(dates).toEqual(dates.toSorted((a, b) => b - a));
});

test("successful secret use updates lastUsedAt", async () => {
  const key = await createKey();
  const secretResponse = await keyRequest(key.key);
  expect(secretResponse.status).toBe(200);
  const summaries = await listKeys();
  const listed = summaries.find((row) => row.id === key.id);
  expect(listed?.lastUsedAt).not.toBeNull();
  expect(Date.parse(listed?.lastUsedAt ?? "")).toBeGreaterThanOrEqual(
    Date.parse(key.createdAt)
  );
});

test("revoke immediately rejects the key, keeps its summary, and audits only once", async () => {
  const key = await createKey();
  const revokeResponse = await revoke(key.id);
  expect(revokeResponse.status).toBe(200);
  await expectError(await keyRequest(key.key), 401, "UNAUTHORIZED");
  const listed = await listKeys();
  expect(listed.find((row) => row.id === key.id)?.revoked).toBe(true);
  const before = await snapshot();
  const again = await revoke(key.id);
  expect(again.status).toBe(200);
  expect(summarySchema.parse(await again.json()).revoked).toBe(true);
  expect(await snapshot()).toEqual(before);
});

test("expired keys are rejected and deleted by the plugin", async () => {
  const key = await createKey();
  await db
    .update(apikey)
    .set({ expiresAt: new Date(0) })
    .where(eq(apikey.id, key.id));
  await expectError(await keyRequest(key.key), 401, "UNAUTHORIZED");
  const listed = await listKeys();
  expect(listed.some((row) => row.id === key.id)).toBe(false);
});

test("another user's revoke matches unknown id and leaves the owner's key usable", async () => {
  const key = await createKey();
  const before = await snapshot();
  const [unowned, unknown] = await Promise.all(
    [key.id, "nonexistent"].map(
      async (id) => await expectError(await revoke(id, userB), 404, "NOT_FOUND")
    )
  );
  expect(unowned).toEqual(unknown);
  expect(await snapshot()).toEqual(before);
  const secretResponse = await keyRequest(key.key);
  expect(secretResponse.status).toBe(200);
});

test("user-only key management rejects API keys with or without a cookie, and anonymous callers", async () => {
  const key = await createKey({ permissions: ["read", "reveal", "inject"] });
  const other = await createKey();
  // Verification updates lastRequest; freeze it to prove refused handlers change no rows.
  const now = Date.now();
  setSystemTime(now);
  try {
    const secretResponse = await keyRequest(key.key);
    expect(secretResponse.status).toBe(200);
    const before = await snapshot();
    const credentials: Record<string, string>[] = [
      { "x-api-key": key.key },
      { "x-api-key": key.key, cookie: userA.cookie },
      {},
    ];
    const routes: [string, string, unknown?][] = [
      ["POST", "/api-keys", { name: "Forbidden", scope }],
      ["GET", "/api-keys"],
      ["POST", `/api-keys/${key.id}/revoke`],
      ["POST", `/api-keys/${other.id}/revoke`],
      ["POST", "/api-keys/nonexistent/revoke"],
    ];
    await Promise.all(
      routes.flatMap(([method, path, body]) =>
        credentials.map(async (headers) => {
          await expectError(
            await request(method, path, headers, body),
            Object.keys(headers).length ? 403 : 401,
            Object.keys(headers).length ? "FORBIDDEN" : "UNAUTHORIZED"
          );
        })
      )
    );
    expect(await snapshot()).toEqual(before);
  } finally {
    setSystemTime();
  }
});

test("create and revoke each record one user audit event without key material", async () => {
  const before = await db.select().from(auditEvent);
  const key = await createKey();
  const afterCreate = await db.select().from(auditEvent);
  expect(afterCreate).toHaveLength(before.length + 1);
  const revokeResponse = await revoke(key.id);
  expect(revokeResponse.status).toBe(200);
  const afterRevoke = await db.select().from(auditEvent);
  expect(afterRevoke).toHaveLength(before.length + 2);
  const events = afterRevoke.filter((event) => event.apiKeyId === key.id);
  expect(events.map((event) => event.action).toSorted()).toEqual([
    "apikey.create",
    "apikey.revoke",
  ]);
  const [stored] = await db.select().from(apikey).where(eq(apikey.id, key.id));
  for (const event of events) {
    expect(event).toMatchObject({
      actorType: "user",
      actorId: userA.id,
      apiKeyId: key.id,
      projectId: null,
      environmentId: null,
      secretId: null,
      ip: "192.0.2.10",
      userAgent: requestMetadata["User-Agent"],
    });
    for (const material of [key.key, stored?.key, stored?.start]) {
      expect(JSON.stringify(event)).not.toContain(material ?? "missing");
    }
  }
});

const failAudit = async (action: "apikey.create" | "apikey.revoke") => {
  await db.execute(sql`CREATE FUNCTION reject_key_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = '${sql.raw(action)}' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await db.execute(
    sql`CREATE TRIGGER reject_key_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION reject_key_audit()`
  );
};
const restoreAudit = async () => {
  await db.execute(sql`DROP TRIGGER reject_key_audit ON audit_event`);
  await db.execute(sql`DROP FUNCTION reject_key_audit()`);
};
test("audit failure compensates creation and rolls back revocation", async () => {
  const before = await snapshot();
  await failAudit("apikey.create");
  try {
    const body = await expectError(
      await request(
        "POST",
        "/api-keys",
        { cookie: userA.cookie },
        { name: "Fail audited", scope }
      ),
      500,
      "INTERNAL_SERVER_ERROR"
    );
    expect(JSON.stringify(body)).not.toContain("jv_");
    expect(await snapshot()).toEqual(before);
  } finally {
    await restoreAudit();
  }
  const key = await createKey();
  const beforeRevoke = await snapshot();
  await failAudit("apikey.revoke");
  try {
    await expectError(await revoke(key.id), 500, "INTERNAL_SERVER_ERROR");
    expect(await snapshot()).toEqual(beforeRevoke);
    const secretResponse = await keyRequest(key.key);
    expect(secretResponse.status).toBe(200);
  } finally {
    await restoreAudit();
  }
});

test("RPC supports session create, list, revoke and rejects API keys", async () => {
  const rpcHandler = new RPCHandler(appRouter);
  const clientFor = (
    headers: Record<string, string>
  ): RouterClient<typeof appRouter> =>
    createORPCClient(
      new RPCLink({
        url: `${baseURL}/api/rpc`,
        headers,
        fetch: async (rpcRequest) => {
          const { response } = await rpcHandler.handle(rpcRequest, {
            prefix: "/api/rpc",
            context: await createContext({
              db,
              auth,
              headers: rpcRequest.headers,
              masterKey: parseMasterKey(masterKey),
            }),
          });
          return response ?? new Response("Not found", { status: 404 });
        },
      })
    );
  const userClient = clientFor({ cookie: userA.cookie });
  const key = await userClient.apiKeys.create({ name: "RPC key", scope });
  const listed = await userClient.apiKeys.list();
  expect(listed.some((row) => row.id === key.id)).toBe(true);
  const keyClient = clientFor({ "x-api-key": key.key });
  await expect(
    keyClient.apiKeys.create({ name: "Forbidden", scope })
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(keyClient.apiKeys.list()).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(keyClient.apiKeys.revoke({ id: key.id })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  const revoked = await userClient.apiKeys.revoke({ id: key.id });
  expect(revoked.revoked).toBe(true);
});

test("migration only makes project_id nullable and adds api_key_id", async () => {
  const migration = await readFile(
    new URL(
      "../../db/src/migrations/20261124194541_sharp_eddie_brock/migration.sql",
      import.meta.url
    ),
    "utf-8"
  );
  expect(
    migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .toSorted()
  ).toEqual(
    [
      'ALTER TABLE "audit_event" ADD COLUMN "api_key_id" text;',
      'ALTER TABLE "audit_event" ALTER COLUMN "project_id" DROP NOT NULL;',
    ].toSorted()
  );
});

test("auth plugin HTTP key management endpoints remain disabled", async () => {
  await Promise.all(
    [
      ["POST", "create"],
      ["GET", "list"],
      ["GET", "get"],
      ["POST", "update"],
      ["POST", "delete"],
    ].map(async ([method, path]) => {
      const response = await auth.handler(
        new Request(`${baseURL}/api/auth/api-key/${path}`, {
          method,
          headers: {
            cookie: userA.cookie,
            Origin: baseURL,
            "Content-Type": "application/json",
          },
        })
      );
      expect(response.status).toBe(404);
    })
  );
});

test("malformed stored scope and permissions fail closed when listed", async () => {
  const key = await createKey();
  await db
    .update(apikey)
    .set({ metadata: "invalid json", permissions: "invalid json" })
    .where(eq(apikey.id, key.id));
  const malformedSummaries = await listKeys();
  expect(malformedSummaries.find((row) => row.id === key.id)).toMatchObject({
    scope: { projects: {} },
    permissions: [],
  });
  await db
    .update(apikey)
    .set({
      metadata: JSON.stringify({ projects: { "my-app": "development" } }),
      permissions: JSON.stringify({
        secrets: ["read", "unknown", "delete", 3],
      }),
    })
    .where(eq(apikey.id, key.id));
  const filteredSummaries = await listKeys();
  expect(filteredSummaries.find((row) => row.id === key.id)).toMatchObject({
    scope: { projects: {} },
    permissions: ["read", "delete"],
  });
});

test("unexpected plugin failures return a generic 500 and change no rows", async () => {
  const before = await snapshot();
  const failure = spyOn(auth.api, "createApiKey").mockRejectedValueOnce(
    new Error("plugin private detail jv_never_expose")
  );
  try {
    const body = await expectError(
      await request(
        "POST",
        "/api-keys",
        { cookie: userA.cookie },
        { name: "Plugin failure", scope }
      ),
      500,
      "INTERNAL_SERVER_ERROR"
    );
    expect(JSON.stringify(body)).not.toContain("plugin private detail");
    expect(JSON.stringify(body)).not.toContain("jv_");
    expect(await snapshot()).toEqual(before);
  } finally {
    failure.mockRestore();
  }
});

test("concurrent revocations write only one event", async () => {
  const key = await createKey();
  const responses = await Promise.all([revoke(key.id), revoke(key.id)]);
  await Promise.all(
    responses.map(async (response) => {
      expect(response.status).toBe(200);
      expect(summarySchema.parse(await response.json()).revoked).toBe(true);
    })
  );
  const events = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.apiKeyId, key.id));
  expect(
    events.filter((event) => event.action === "apikey.revoke")
  ).toHaveLength(1);
});

test("invalid, revoked and expired keys cannot use a cookie to manage keys", async () => {
  const revoked = await createKey();
  const revokeResponse = await revoke(revoked.id);
  expect(revokeResponse.status).toBe(200);
  const expired = await createKey();
  await db
    .update(apikey)
    .set({ expiresAt: new Date(0) })
    .where(eq(apikey.id, expired.id));
  // Expiry cleanup belongs to authentication and happens before the handlers run.
  await expectError(await keyRequest(expired.key), 401, "UNAUTHORIZED");
  const before = await snapshot();
  const routes: [string, string, unknown?][] = [
    ["POST", "/api-keys", { name: "Forbidden", scope }],
    ["GET", "/api-keys"],
    ["POST", `/api-keys/${revoked.id}/revoke`],
    ["POST", "/api-keys/current/revoke"],
  ];
  await Promise.all(
    ["jv_invalid", revoked.key, expired.key].flatMap((key) =>
      routes.map(async ([method, path, body]) => {
        await expectError(
          await request(
            method,
            path,
            { "x-api-key": key, cookie: userA.cookie },
            body
          ),
          401,
          "UNAUTHORIZED"
        );
      })
    )
  );
  expect(await snapshot()).toEqual(before);
});

test.each(["x-api-key", "Authorization"])(
  "self-revoke via %s returns only a summary and audits the key actor once",
  async (header) => {
    const key = await createKey();
    const before = await db.select().from(auditEvent);
    const response = await request("POST", "/api-keys/current/revoke", {
      [header]: header === "Authorization" ? `Bearer ${key.key}` : key.key,
    });
    expect(response.status).toBe(200);
    const body = summarySchema.parse(await response.json());
    expect(body).toMatchObject({ id: key.id, revoked: true });
    await expectError(await keyRequest(key.key), 401, "UNAUTHORIZED");
    const listed = await listKeys();
    expect(listed.find((row) => row.id === key.id)?.revoked).toBe(true);
    const after = await db.select().from(auditEvent);
    expect(after).toHaveLength(before.length + 1);
    const events = after.filter(
      (event) => event.apiKeyId === key.id && event.action === "apikey.revoke"
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "apikey.revoke",
      actorType: "apiKey",
      actorId: key.id,
      apiKeyId: key.id,
      projectId: null,
      environmentId: null,
      secretId: null,
      ip: "192.0.2.10",
      userAgent: requestMetadata["User-Agent"],
    });
    const [stored] = await db
      .select()
      .from(apikey)
      .where(eq(apikey.id, key.id));
    for (const material of [key.key, stored?.key, stored?.start]) {
      expect(JSON.stringify({ body, events })).not.toContain(
        material ?? "missing"
      );
    }
    await expectError(
      await request("POST", "/api-keys/current/revoke", {
        "x-api-key": key.key,
      }),
      401,
      "UNAUTHORIZED"
    );
    expect(await db.select().from(auditEvent)).toHaveLength(after.length);
  }
);

test("self-revoke requires no scope or secret permissions", async () => {
  const key = await createKey();
  await db
    .update(apikey)
    .set({
      metadata: JSON.stringify({ projects: {} }),
      permissions: JSON.stringify({ secrets: [] }),
    })
    .where(eq(apikey.id, key.id));
  const response = await request("POST", "/api-keys/current/revoke", {
    "x-api-key": key.key,
  });
  expect(response.status).toBe(200);
  expect(summarySchema.parse(await response.json()).revoked).toBe(true);
});

test("self-revoke rejects user and anonymous principals without changes", async () => {
  const before = await snapshot();
  await expectError(
    await request("POST", "/api-keys/current/revoke", { cookie: userA.cookie }),
    403,
    "FORBIDDEN"
  );
  await expectError(
    await request("POST", "/api-keys/current/revoke", {}),
    401,
    "UNAUTHORIZED"
  );
  expect(await snapshot()).toEqual(before);
});

test("audit failure rolls back self-revocation and leaves the key usable", async () => {
  const key = await createKey();
  setSystemTime(Date.now());
  try {
    const working = await keyRequest(key.key);
    expect(working.status).toBe(200);
    const before = await snapshot();
    await failAudit("apikey.revoke");
    try {
      await expectError(
        await request("POST", "/api-keys/current/revoke", {
          "x-api-key": key.key,
        }),
        500,
        "INTERNAL_SERVER_ERROR"
      );
      expect(await snapshot()).toEqual(before);
      const stillWorking = await keyRequest(key.key);
      expect(stillWorking.status).toBe(200);
    } finally {
      await restoreAudit();
    }
  } finally {
    setSystemTime();
  }
});
