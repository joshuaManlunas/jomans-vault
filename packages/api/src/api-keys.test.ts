import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createAuth } from "@jomans-vault/auth";
import { parseMasterKey } from "@jomans-vault/crypto";
import { createDb } from "@jomans-vault/db";
import { apikey } from "@jomans-vault/db/schema/auth";
import {
  auditEvent,
  environment,
  project,
  secret,
  secretVersion,
} from "@jomans-vault/db/schema/vault";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { eq } from "drizzle-orm";
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
const databaseName = `jomans_vault_keys_${crypto.randomUUID().replaceAll("-", "")}`;
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.pathname = `/${databaseName}`;
const admin = new Pool({ connectionString: databaseUrl });
const db = createDb({ DATABASE_URL: isolatedUrl.toString() });
const baseURL = "http://localhost:5120";
const auth = createAuth(
  {
    BETTER_AUTH_URL: baseURL,
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  },
  db
);
const masterKey = btoa(
  String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))
);
const handler = createVaultApiHandler({ db, auth, masterKey });
const keyBytes = parseMasterKey(masterKey);
const scope = { projects: { "my-app": ["development", "missing"] } };
const secretValue = "private-api-key-test-value";
const envPath = "/projects/my-app/envs/development";
const listPath = `${envPath}/secrets`;
const valuePath = `${listPath}/TOKEN`;
const requestMetadata = {
  "User-Agent": "Scoped key test",
  "X-Forwarded-For": "192.0.2.10, 192.0.2.11",
};
interface TestUser {
  cookie: string;
  id: string;
}
type CreatedKey = Awaited<ReturnType<typeof auth.api.createApiKey>>;
let userA: TestUser;
let userB: TestUser;
let keys: Record<"read" | "reveal" | "inject" | "all" | "other", CreatedKey>;
let created = false;

const signupUser = async (email: string): Promise<TestUser> => {
  const response = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseURL },
      body: JSON.stringify({
        email,
        password: crypto.randomUUID(),
        name: "Scoped Key Tester",
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
const keyRequest = async (
  key: string,
  path = listPath,
  method = "GET",
  body?: unknown
) => await request(method, path, { Authorization: `Bearer ${key}` }, body);
const createKey = async (
  permissions?: string[],
  metadata: unknown = scope,
  userId = userA.id
) =>
  await auth.api.createApiKey({
    body: {
      userId,
      metadata,
      ...(permissions === undefined
        ? {}
        : { permissions: { secrets: permissions } }),
    },
  });

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../db/src/migrations", import.meta.url)
    ),
  });
  userA = await signupUser("key-owner@example.com");
  userB = await signupUser("other-key-owner@example.com");
  const cookie = { cookie: userA.cookie };
  await Promise.all(
    ["my-app", "other-app"].map(async (slug) => {
      const response = await request("POST", "/projects", cookie, {
        slug,
        name: slug,
      });
      expect(response.status).toBe(201);
      await Promise.all(
        ["development", "production"].map(async (env) => {
          const environmentResponse = await request(
            "POST",
            `/projects/${slug}/envs`,
            cookie,
            { slug: env }
          );
          expect(environmentResponse.status).toBe(201);
        })
      );
    })
  );
  const write = await request("PUT", valuePath, cookie, { value: secretValue });
  expect(write.status).toBe(200);
  keys = {
    read: await createKey(["read"]),
    reveal: await createKey(["reveal"]),
    inject: await createKey(["inject"]),
    all: await createKey(["read", "reveal", "inject"]),
    other: await createKey(["read", "reveal", "inject"], scope, userB.id),
  };
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

const expectError = async (
  response: Response,
  status: number,
  code: string
) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const anonymous = await request("GET", "/private-data", {});
  const anonymousBody = z
    .record(z.string(), z.unknown())
    .parse(await anonymous.json());
  const body = z.record(z.string(), z.unknown()).parse(await response.json());
  expect(body).toEqual({
    ...anonymousBody,
    code,
    status,
    message: {
      FORBIDDEN: "Forbidden",
      NOT_FOUND: "Not Found",
      UNAUTHORIZED: "Unauthorized",
    }[code],
  });
  for (const field of ["reason", "data", "cause"]) {
    expect(body).not.toHaveProperty(field);
  }
};

test("authenticated HTTP requests cannot manage API keys", async () => {
  const key = await createKey(["read"]);
  const before = await db.select().from(apikey).orderBy(apikey.id);
  const auditBefore = await db.select().from(auditEvent).orderBy(auditEvent.id);
  const routes: [string, string, unknown?][] = [
    ["POST", "create", { metadata: scope }],
    ["GET", "list"],
    ["GET", `get?id=${key.id}`],
    ["POST", "update", { keyId: key.id, name: "HTTP changed" }],
    ["POST", "delete", { keyId: key.id }],
  ];
  await Promise.all(
    routes.flatMap(([method, path, body]) =>
      ["", "/"].map(async (suffix) => {
        const url = new URL(`${baseURL}/api/auth/api-key/${path}`);
        url.pathname += suffix;
        const response = await auth.handler(
          new Request(url.toString(), {
            method,
            headers: {
              "Content-Type": "application/json",
              Origin: baseURL,
              cookie: userA.cookie,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("Not Found");
      })
    )
  );
  expect(await db.select().from(apikey).orderBy(apikey.id)).toEqual(before);
  expect(await db.select().from(auditEvent).orderBy(auditEvent.id)).toEqual(
    auditBefore
  );
});

test("trusted server API key management remains available", async () => {
  const key = await createKey(["read"]);
  await auth.api.updateApiKey({
    body: { keyId: key.id, userId: userA.id, name: "Server changed" },
  });
  const headers = new Headers({ cookie: userA.cookie });
  const stored = await auth.api.getApiKey({ query: { id: key.id }, headers });
  expect(stored.name).toBe("Server changed");
  const listed = await auth.api.listApiKeys({ query: {}, headers });
  expect(listed.apiKeys).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: key.id })])
  );
  const response = await keyRequest(key.key);
  expect(response.status).toBe(200);
  await auth.api.deleteApiKey({ body: { keyId: key.id }, headers });
  expect(await db.select().from(apikey).where(eq(apikey.id, key.id))).toEqual(
    []
  );
  await expectError(await keyRequest(key.key), 401, "UNAUTHORIZED");
});

test("both key headers trim values, match Bearer case-insensitively, and accept equal keys", async () => {
  const headerCases: Record<string, string>[] = [
    { Authorization: `Bearer ${keys.read.key}` },
    { Authorization: `bEaReR   ${keys.read.key}  ` },
    { "x-api-key": `  ${keys.read.key}  ` },
    { Authorization: `Bearer ${keys.read.key}`, "x-api-key": keys.read.key },
    { Authorization: "Basic ignored", "x-api-key": keys.read.key },
  ];
  await Promise.all(
    headerCases.map(async (headers) => {
      const response = await request("GET", listPath, headers);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([
        { key: "TOKEN", version: 1 },
      ]);
    })
  );
});

test.each([
  { key: "read", path: listPath, status: 200 },
  { key: "read", path: `${valuePath}/versions`, status: 200 },
  { key: "read", path: valuePath, status: 403 },
  { key: "read", path: `${envPath}/export`, status: 403 },
  { key: "reveal", path: valuePath, status: 200 },
  { key: "reveal", path: listPath, status: 403 },
  { key: "reveal", path: `${valuePath}/versions`, status: 403 },
  { key: "reveal", path: `${envPath}/export`, status: 403 },
  { key: "inject", path: `${envPath}/export`, status: 200 },
  { key: "inject", path: listPath, status: 403 },
  { key: "inject", path: valuePath, status: 403 },
  { key: "all", path: "/projects/my-app/envs/production/secrets", status: 403 },
  {
    key: "read",
    path: "/projects/other-app/envs/development/secrets",
    status: 403,
  },
  {
    key: "all",
    path: "/projects/my-app/envs/out-of-scope/secrets",
    status: 403,
  },
  { key: "reveal", path: "/projects/my-app/envs/missing/secrets", status: 404 },
  {
    key: "all",
    path: "/projects/unknown/envs/development/secrets",
    status: 404,
  },
  { key: "other", path: listPath, status: 404 },
  { key: "other", path: valuePath, status: 404 },
  { key: "other", path: `${envPath}/export`, status: 404 },
] as const)("$key on $path returns $status", async ({ key, path, status }) => {
  const response = await keyRequest(keys[key].key, path);
  if (status !== 200) {
    await expectError(
      response,
      status,
      status === 403 ? "FORBIDDEN" : "NOT_FOUND"
    );
    return;
  }
  expect(response.status).toBe(200);
  if (path === valuePath) {
    expect(await response.json()).toEqual({
      key: "TOKEN",
      value: secretValue,
      version: 1,
    });
  } else if (path.endsWith("/export")) {
    expect(await response.json()).toEqual({ TOKEN: secretValue });
  }
});

test("invalid keys and ambiguous headers never fall back to a valid cookie", async () => {
  const disabled = await createKey(["read"]);
  await auth.api.updateApiKey({
    body: { keyId: disabled.id, userId: userA.id, enabled: false },
  });
  const deleted = await createKey(["read"]);
  await auth.api.deleteApiKey({
    body: { keyId: deleted.id },
    headers: new Headers({ cookie: userA.cookie }),
  });
  const expired = await createKey(["read"]);
  await db
    .update(apikey)
    .set({ expiresAt: new Date(0) })
    .where(eq(apikey.id, expired.id));
  const madeUp = `jv_${"x".repeat(64)}`;
  const cases: Record<string, string>[] = [
    { Authorization: `Bearer ${disabled.key}` },
    { Authorization: `Bearer ${deleted.key}` },
    { Authorization: `Bearer ${expired.key}` },
    { Authorization: `Bearer ${madeUp}` },
    { "x-api-key": madeUp },
    { Authorization: `Bearer ${madeUp}`, cookie: userA.cookie },
    {
      Authorization: `Bearer ${keys.read.key}`,
      "x-api-key": keys.all.key,
      cookie: userA.cookie,
    },
  ];
  const getSession = spyOn(auth.api, "getSession");
  try {
    /* oxlint-disable no-await-in-loop -- Count session calls separately for each rejected credential. */
    for (const headers of cases) {
      const response = await request("GET", listPath, headers);
      const calls = getSession.mock.calls.length;
      await expectError(response, 401, "UNAUTHORIZED");
      // expectError makes one anonymous request; only that request may ask for a session.
      expect(getSession.mock.calls.length).toBe(calls + 1);
    }
    /* oxlint-enable no-await-in-loop */
    expect(getSession).toHaveBeenCalledTimes(cases.length);
  } finally {
    getSession.mockRestore();
  }
});

const snapshotVault = async () => ({
  projects: await db.select().from(project),
  environments: await db.select().from(environment),
  secrets: await db.select().from(secret),
  versions: await db.select().from(secretVersion),
  audit: await db.select().from(auditEvent),
});

test("all user-only routes reject even a fully scoped key before project lookup without changing rows", async () => {
  const before = await snapshotVault();
  await Promise.all(
    ["my-app", "unowned-project"].map(async (projectSlug) => {
      const projectPath = `/projects/${projectSlug}`;
      const environmentPath = `${projectPath}/envs/development`;
      const secretPath = `${environmentPath}/secrets/TOKEN`;
      const routes: [string, string, unknown?][] = [
        ["POST", "/projects", { slug: "blocked", name: "Blocked" }],
        ["GET", "/projects"],
        ["PATCH", projectPath, { name: "Blocked" }],
        ["DELETE", projectPath],
        ["POST", `${projectPath}/envs`, { slug: "blocked" }],
        ["GET", `${projectPath}/envs`],
        ["DELETE", environmentPath],
        ["PUT", secretPath, { value: "blocked" }],
        ["PATCH", secretPath, { value: "blocked", expectedVersion: 1 }],
        ["DELETE", secretPath],
        ["POST", `${secretPath}/rollback`, { version: 1 }],
        ["GET", "/private-data"],
      ];
      await Promise.all(
        routes.map(async ([method, path, body]) => {
          await expectError(
            await keyRequest(keys.all.key, path, method, body),
            403,
            "FORBIDDEN"
          );
        })
      );
    })
  );
  const health = await keyRequest("jv_invalid", "/health");
  expect(health.status).toBe(200);
  expect(await health.json()).toBe("OK");
  expect(await snapshotVault()).toEqual(before);
});

test("RPC uses the same key permission boundary", async () => {
  const rpcHandler = new RPCHandler(appRouter);
  const link = new RPCLink({
    url: `${baseURL}/api/rpc`,
    headers: { "x-api-key": keys.all.key, cookie: userA.cookie },
    fetch: async (rpcRequest) => {
      const { response } = await rpcHandler.handle(rpcRequest, {
        prefix: "/api/rpc",
        context: await createContext({
          db,
          auth,
          headers: rpcRequest.headers,
          masterKey: keyBytes,
        }),
      });
      return response ?? new Response("Not found", { status: 404 });
    },
  });
  const client: RouterClient<typeof appRouter> = createORPCClient(link);
  await expect(client.projects.list()).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(
    client.secrets.set({
      project: "my-app",
      env: "development",
      key: "TOKEN",
      value: "blocked",
    })
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(
    await client.secrets.list({ project: "my-app", env: "development" })
  ).toMatchObject([{ key: "TOKEN", version: 1 }]);
});

test("reveal and export audit the key id and request metadata, while list and history write nothing", async () => {
  const key = await createKey(["read", "reveal", "inject"]);
  const before = await db.select().from(auditEvent);
  const reads = await Promise.all(
    [listPath, `${valuePath}/versions`].map(
      async (path) => await keyRequest(key.key, path)
    )
  );
  for (const response of reads) {
    expect(response.status).toBe(200);
  }
  expect(await db.select().from(auditEvent)).toEqual(before);
  const reveals = await Promise.all(
    [valuePath, `${envPath}/export`].map(
      async (path) => await keyRequest(key.key, path)
    )
  );
  for (const response of reveals) {
    expect(response.status).toBe(200);
  }
  const allEvents = await db.select().from(auditEvent);
  expect(allEvents).toHaveLength(before.length + 2);
  const events = allEvents.filter((event) => event.actorId === key.id);
  expect(events).toHaveLength(2);
  expect(events.map((event) => event.action).toSorted()).toEqual([
    "secret.export",
    "secret.reveal",
  ]);
  for (const event of events) {
    expect(event).toMatchObject({
      actorType: "apiKey",
      actorId: key.id,
      ip: "192.0.2.10",
      userAgent: "Scoped key test",
    });
    expect(JSON.stringify(event)).not.toContain(secretValue);
    expect(JSON.stringify(event)).not.toContain(key.key);
  }
});

test("key rate limiting is disabled for twelve consecutive requests", async () => {
  const key = await createKey(["read"]);
  for (let count = 0; count < 12; count += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Exercise twelve consecutive validations of the same key.
    const response = await keyRequest(key.key);
    expect(response.status).toBe(200);
  }
});

test("default permissions only allow read and the stored row never contains the plaintext key", async () => {
  const key = await createKey();
  expect(key.permissions).toEqual({ secrets: ["read"] });
  expect(key.key.startsWith("jv_")).toBe(true);
  const response = await keyRequest(key.key);
  expect(response.status).toBe(200);
  await Promise.all(
    [valuePath, `${envPath}/export`].map(async (path) => {
      await expectError(await keyRequest(key.key, path), 403, "FORBIDDEN");
    })
  );
  const [row] = await db.select().from(apikey).where(eq(apikey.id, key.id));
  expect(row).toBeDefined();
  expect(JSON.stringify(row)).not.toContain(key.key);
});

test.each([
  null,
  {},
  { projects: { "my-app": "development" } },
  { projects: ["my-app"] },
  "unreadable",
])(
  "missing or malformed scope %j grants no project access",
  async (metadata) => {
    const key = await createKey(
      ["read"],
      typeof metadata === "string" ? scope : metadata
    );
    if (typeof metadata === "string") {
      await db
        .update(apikey)
        .set({ metadata: JSON.stringify(metadata) })
        .where(eq(apikey.id, key.id));
    }
    await expectError(await keyRequest(key.key), 403, "FORBIDDEN");
  }
);

test("unknown permissions are discarded and do not grant reveal or inject", async () => {
  const key = await createKey(["read", "write", "delete", "unknown"]);
  const context = await createContext({
    db,
    auth,
    headers: new Headers({ "x-api-key": key.key }),
    masterKey: keyBytes,
  });
  expect(context.principal).toEqual({
    type: "apiKey",
    keyId: key.id,
    userId: userA.id,
    scope,
    permissions: ["read"],
  });
  const response = await keyRequest(key.key);
  expect(response.status).toBe(200);
  await Promise.all(
    [valuePath, `${envPath}/export`].map(async (path) => {
      await expectError(await keyRequest(key.key, path), 403, "FORBIDDEN");
    })
  );
});

test("verification failures are anonymous and never ask for a session", async () => {
  const verification = spyOn(auth.api, "verifyApiKey").mockRejectedValueOnce(
    new Error("Verification unavailable")
  );
  const session = spyOn(auth.api, "getSession");
  let response: Response;
  try {
    response = await request("GET", listPath, {
      "x-api-key": keys.read.key,
      cookie: userA.cookie,
    });
    expect(session).not.toHaveBeenCalled();
  } finally {
    verification.mockRestore();
    session.mockRestore();
  }
  await expectError(response, 401, "UNAUTHORIZED");
});

test("an unrelated authorization scheme and empty key sources preserve cookie sessions", async () => {
  const headerCases: Record<string, string>[] = [
    { Authorization: "Basic ignored" },
    { Authorization: "Bearer   ", "x-api-key": "  " },
    {},
  ];
  await Promise.all(
    headerCases.map(async (headers) => {
      const response = await request("GET", "/private-data", {
        ...headers,
        cookie: userA.cookie,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ user: { id: userA.id } });
    })
  );
});
