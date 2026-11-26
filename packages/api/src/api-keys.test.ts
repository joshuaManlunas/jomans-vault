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
  projectKey,
  secret,
  secretVersion,
} from "@jomans-vault/db/schema/vault";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { and, asc, eq } from "drizzle-orm";
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
let storedScope: typeof scope & {
  grants: Record<string, Record<string, string>>;
};
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
  metadata: unknown = storedScope,
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
  const missing = await request(
    "POST",
    "/projects/my-app/envs",
    { cookie: userA.cookie },
    { slug: "missing" }
  );
  expect(missing.status).toBe(201);
  const granted = await db
    .select({
      projectId: project.id,
      slug: environment.slug,
      id: environment.id,
    })
    .from(project)
    .innerJoin(environment, eq(environment.projectId, project.id))
    .where(eq(project.ownerId, userA.id));
  const myProject = await db
    .select()
    .from(project)
    .where(eq(project.slug, "my-app"));
  const myProjectId = myProject[0]?.id;
  if (!myProjectId) {
    throw new Error("Seeded project not found");
  }
  storedScope = {
    ...scope,
    grants: {
      [myProjectId]: Object.fromEntries(
        granted
          .filter(
            (row) =>
              row.projectId === myProjectId &&
              scope.projects["my-app"].includes(row.slug)
          )
          .map((row) => [row.slug, row.id])
      ),
    },
  };
  const removed = await request("DELETE", "/projects/my-app/envs/missing", {
    cookie: userA.cookie,
  });
  expect(removed.status).toBe(204);
  keys = {
    read: await createKey(["read"]),
    reveal: await createKey(["reveal"]),
    inject: await createKey(["inject"]),
    all: await createKey(["read", "reveal", "inject", "write", "delete"]),
    other: await createKey(["read", "reveal", "inject"], storedScope, userB.id),
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
      CONFLICT: "Conflict",
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
      const routes: [string, string, unknown?][] = [
        ["POST", "/projects", { slug: "blocked", name: "Blocked" }],
        ["GET", "/projects"],
        ["PATCH", projectPath, { name: "Blocked" }],
        ["DELETE", projectPath],
        ["POST", `${projectPath}/envs`, { slug: "blocked" }],
        ["GET", `${projectPath}/envs`],
        ["DELETE", environmentPath],
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
  const rpcClient = (key: string): RouterClient<typeof appRouter> =>
    createORPCClient(
      new RPCLink({
        url: `${baseURL}/api/rpc`,
        headers: { "x-api-key": key, cookie: userA.cookie },
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
      })
    );
  const client = rpcClient(keys.read.key);
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
  const writer = await createKey(["write"]);
  expect(
    await rpcClient(writer.key).secrets.set({
      project: "my-app",
      env: "development",
      key: "RPC_WRITE",
      value: "rpc-private-value",
    })
  ).toEqual({
    key: "RPC_WRITE",
    kind: "secret",
    version: 1,
    updatedAt: expect.any(String),
  });
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
  scope,
  { grants: { invalid: ["development"] } },
  { grants: { invalid: { development: 123 } } },
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
    scope: { grants: storedScope.grants },
    permissions: ["read", "write", "delete"],
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

const mutationRoutes = [
  {
    method: "PUT",
    suffix: "",
    body: { value: "key-written-value" },
    permission: "write",
    status: 200,
  },
  {
    method: "PATCH",
    suffix: "",
    body: { value: "key-updated-value", expectedVersion: 1 },
    permission: "write",
    status: 200,
  },
  {
    method: "POST",
    suffix: "/rollback",
    body: { version: 1 },
    permission: "write",
    status: 200,
  },
  {
    method: "DELETE",
    suffix: "",
    body: undefined,
    permission: "delete",
    status: 204,
  },
] as const;
const allPermissions = ["read", "reveal", "inject", "write", "delete"];

const seedSecret = async () => {
  const key = `MUTATION_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const path = `${listPath}/${key}`;
  const response = await request(
    "PUT",
    path,
    { cookie: userA.cookie },
    {
      value: "user-written-value",
    }
  );
  expect(response.status).toBe(200);
  return { key, path };
};

test.each(
  mutationRoutes.flatMap((route) => [
    {
      ...route,
      permissions: [route.permission],
      permissionCase: "required permission",
      expected: route.status,
    },
    {
      ...route,
      permissions: allPermissions.filter(
        (permission) => permission !== route.permission
      ),
      permissionCase: "every other permission",
      expected: 403,
    },
    {
      ...route,
      permissions: [route.permission === "write" ? "delete" : "write"],
      permissionCase: "opposite mutation permission",
      expected: 403,
    },
  ])
)(
  "$method with $permissionCase returns $expected",
  async ({ method, suffix, body, permissions, expected }) => {
    const { key: secretKey, path } = await seedSecret();
    const key = await createKey(permissions);
    const before = await snapshotVault();
    const response = await keyRequest(
      key.key,
      `${path}${suffix}`,
      method,
      body
    );
    if (expected === 403) {
      await expectError(response, 403, "FORBIDDEN");
      expect(await snapshotVault()).toEqual(before);
      return;
    }
    expect(response.status).toBe(expected);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    if (method === "DELETE") {
      expect(await response.text()).toBe("");
      const list = await keyRequest(keys.read.key);
      expect(list.status).toBe(200);
      expect(await list.json()).not.toContainEqual(
        expect.objectContaining({ key: secretKey })
      );
      return;
    }
    const output = await response.json();
    expect(output).toEqual({
      key: secretKey,
      kind: "secret",
      version: 2,
      updatedAt: expect.any(String),
    });
  }
);

test.each(
  mutationRoutes.flatMap((route) => [
    {
      ...route,
      scopeCase: "owned out-of-scope env",
      projectSlug: "my-app",
      env: "production",
      user: "owner",
      status: 403,
    },
    {
      ...route,
      scopeCase: "owned out-of-scope project",
      projectSlug: "other-app",
      env: "development",
      user: "owner",
      status: 403,
    },
    {
      ...route,
      scopeCase: "other owner's project named in scope",
      projectSlug: "my-app",
      env: "development",
      user: "other",
      status: 404,
    },
    {
      ...route,
      scopeCase: "in-scope missing env",
      projectSlug: "my-app",
      env: "missing",
      user: "owner",
      status: 404,
    },
  ])
)(
  "$method refuses $scopeCase without changing rows",
  async ({
    method,
    suffix,
    body,
    permission,
    projectSlug,
    env,
    user,
    status,
  }) => {
    const key = await createKey(
      [permission],
      storedScope,
      user === "owner" ? userA.id : userB.id
    );
    const before = await snapshotVault();
    const path = `/projects/${projectSlug}/envs/${env}/secrets/TOKEN${suffix}`;
    await expectError(
      await keyRequest(key.key, path, method, body),
      status,
      status === 403 ? "FORBIDDEN" : "NOT_FOUND"
    );
    expect(await snapshotVault()).toEqual(before);
  }
);

test("write alone creates secrets without granting reveal or inject", async () => {
  const key = await createKey(["write"]);
  const path = `${listPath}/WRITE_ONLY`;
  const response = await keyRequest(key.key, path, "PUT", {
    value: "write-only-private-value",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    key: "WRITE_ONLY",
    kind: "secret",
    version: 1,
    updatedAt: expect.any(String),
  });
  await Promise.all(
    [path, `${envPath}/export`].map(async (readPath) => {
      await expectError(await keyRequest(key.key, readPath), 403, "FORBIDDEN");
    })
  );
});

test("key mutations attribute every version and audit event without exposing values or credentials", async () => {
  const key = await createKey(["write", "delete"]);
  const { key: secretKey, path } = await seedSecret();
  const mutations = [
    {
      method: "PUT",
      suffix: "",
      body: { value: "audit-set-private-value" },
      action: "secret.write",
      version: 2,
    },
    {
      method: "PATCH",
      suffix: "",
      body: { value: "audit-patch-private-value", expectedVersion: 2 },
      action: "secret.write",
      version: 3,
    },
    {
      method: "POST",
      suffix: "/rollback",
      body: { version: 1 },
      action: "secret.rollback",
      version: 4,
    },
    {
      method: "DELETE",
      suffix: "",
      body: undefined,
      action: "secret.delete",
      version: undefined,
    },
  ];
  /* oxlint-disable no-await-in-loop -- Each mutation depends on the preceding version and has its own audit assertion. */
  for (const [index, mutation] of mutations.entries()) {
    const response = await keyRequest(
      key.key,
      `${path}${mutation.suffix}`,
      mutation.method,
      mutation.body
    );
    expect(response.status).toBe(mutation.version === undefined ? 204 : 200);
    if (mutation.version === undefined) {
      expect(await response.text()).toBe("");
    } else {
      expect(await response.json()).toEqual({
        key: secretKey,
        kind: "secret",
        version: mutation.version,
        updatedAt: expect.any(String),
      });
    }
    const events = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.actorId, key.id));
    expect(events).toHaveLength(index + 1);
    expect(events.map((event) => event.action).toSorted()).toEqual(
      mutations
        .slice(0, index + 1)
        .map((event) => event.action)
        .toSorted()
    );
    for (const event of events) {
      expect(event).toMatchObject({
        actorType: "apiKey",
        actorId: key.id,
        ip: "192.0.2.10",
        userAgent: "Scoped key test",
      });
      for (const sensitive of [
        "user-written-value",
        "audit-set-private-value",
        "audit-patch-private-value",
        key.key,
      ]) {
        expect(JSON.stringify(event)).not.toContain(sensitive);
      }
    }
  }
  /* oxlint-enable no-await-in-loop */
  const versions = await keyRequest(keys.read.key, `${path}/versions`);
  expect(versions.status).toBe(200);
  expect(await versions.json()).toEqual(
    [1, 2, 3, 4].map((version) => ({
      version,
      createdByType: version === 1 ? "user" : "apiKey",
      createdById: version === 1 ? userA.id : key.id,
      createdAt: expect.any(String),
    }))
  );
});

test("stale key updates and missing mutation targets leave the vault unchanged", async () => {
  const key = await createKey(["write", "delete"]);
  const { path } = await seedSecret();
  const failures: [string, string, unknown, number, string][] = [
    ["PATCH", path, { value: "stale", expectedVersion: 2 }, 409, "CONFLICT"],
    [
      "PATCH",
      `${listPath}/ABSENT_MUTATION`,
      { value: "missing", expectedVersion: 1 },
      404,
      "NOT_FOUND",
    ],
    ["DELETE", `${listPath}/ABSENT_MUTATION`, undefined, 404, "NOT_FOUND"],
    [
      "POST",
      `${listPath}/ABSENT_MUTATION/rollback`,
      { version: 1 },
      404,
      "NOT_FOUND",
    ],
    ["POST", `${path}/rollback`, { version: 999 }, 404, "NOT_FOUND"],
  ];
  const before = await snapshotVault();
  await Promise.all(
    failures.map(async ([method, target, body, status, code]) => {
      await expectError(
        await keyRequest(key.key, target, method, body),
        status,
        code
      );
    })
  );
  expect(await snapshotVault()).toEqual(before);
});

test("write-only rollback restores a key-deleted secret by copying ciphertext without a decryption key", async () => {
  const writer = await createKey(["write"]);
  const deleter = await createKey(["delete"]);
  const { key, path } = await seedSecret();
  const [row] = await db.select().from(secret).where(eq(secret.key, key));
  expect(row).toBeDefined();
  if (!row) {
    throw new Error("Seeded secret not found");
  }
  const [source] = await db
    .select()
    .from(secretVersion)
    .where(eq(secretVersion.secretId, row.id));
  expect(source).toBeDefined();
  const deleted = await keyRequest(deleter.key, path, "DELETE");
  expect(deleted.status).toBe(204);
  const list = await keyRequest(keys.read.key);
  expect(await list.json()).not.toContainEqual(
    expect.objectContaining({ key })
  );
  const [ownedKey] = await db
    .select({ dataKey: projectKey })
    .from(projectKey)
    .innerJoin(project, eq(projectKey.projectId, project.id))
    .where(and(eq(project.slug, "my-app"), eq(project.ownerId, userA.id)));
  const dataKey = ownedKey?.dataKey;
  if (!dataKey) {
    throw new Error("Seeded project data key not found");
  }
  // Retiring the DEK makes decryption unavailable; rollback must only copy stored bytes.
  await db
    .update(projectKey)
    .set({ retiredAt: new Date() })
    .where(eq(projectKey.id, dataKey.id));
  let restored: Response;
  try {
    restored = await keyRequest(writer.key, `${path}/rollback`, "POST", {
      version: 1,
    });
  } finally {
    await db
      .update(projectKey)
      .set({ retiredAt: null })
      .where(eq(projectKey.id, dataKey.id));
  }
  expect(restored.status).toBe(200);
  expect(await restored.json()).toEqual({
    key,
    kind: "secret",
    version: 2,
    updatedAt: expect.any(String),
  });
  const versions = await db
    .select()
    .from(secretVersion)
    .where(eq(secretVersion.secretId, row.id))
    .orderBy(asc(secretVersion.version));
  expect(versions).toHaveLength(2);
  expect(versions[1]).toMatchObject({
    ciphertext: source?.ciphertext,
    iv: source?.iv,
    createdByType: "apiKey",
    createdById: writer.id,
  });
  const after = await keyRequest(keys.read.key);
  expect(await after.json()).toContainEqual(
    expect.objectContaining({ key, version: 2 })
  );
});

test("legacy scopes remain visible and revocable but grant no access", async () => {
  const legacyScope = { projects: { "my-app": ["development"] } };
  const key = await createKey(["read"], legacyScope);
  await expectError(await keyRequest(key.key), 403, "FORBIDDEN");
  const listed = await request("GET", "/api-keys", { cookie: userA.cookie });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toContainEqual(
    expect.objectContaining({ id: key.id, scope: legacyScope })
  );
  const revoked = await request("POST", `/api-keys/${key.id}/revoke`, {
    cookie: userA.cookie,
  });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toMatchObject({
    scope: legacyScope,
    revoked: true,
  });
});

test("an inherited environment property is outside the grant", async () => {
  const before = await snapshotVault();
  await expectError(
    await keyRequest(
      keys.read.key,
      "/projects/my-app/envs/constructor/secrets"
    ),
    403,
    "FORBIDDEN"
  );
  expect(await snapshotVault()).toEqual(before);
});

const recreationRoutes = [
  { permission: "read", method: "GET", suffix: "/secrets", status: 200 },
  { permission: "inject", method: "GET", suffix: "/export", status: 200 },
  {
    permission: "reveal",
    method: "GET",
    suffix: "/secrets/TOKEN",
    status: 200,
  },
  {
    permission: "write",
    method: "PUT",
    suffix: "/secrets/TOKEN",
    body: { value: "replacement" },
    status: 200,
  },
  {
    permission: "delete",
    method: "DELETE",
    suffix: "/secrets/TOKEN",
    status: 204,
  },
] as const;

test.each(
  (["project", "environment"] as const).flatMap((recreate) =>
    recreationRoutes.map((route) => ({ recreate, ...route }))
  )
)("$permission key cannot access a recreated $recreate", async (route) => {
  const slug = `recreate-${crypto.randomUUID()}`;
  const projectPath = `/projects/${slug}`;
  const environmentPath = `${projectPath}/envs/development`;
  const cookie = { cookie: userA.cookie };
  const createProject = async () => {
    const response = await request("POST", "/projects", cookie, {
      slug,
      name: slug,
    });
    expect(response.status).toBe(201);
  };
  const createEnvironment = async () => {
    const response = await request("POST", `${projectPath}/envs`, cookie, {
      slug: "development",
    });
    expect(response.status).toBe(201);
  };
  const issuedScope = { projects: { [slug]: ["development"] } };
  const issue = async () => {
    const response = await request("POST", "/api-keys", cookie, {
      name: "Recreation regression",
      scope: issuedScope,
      permissions: [route.permission],
    });
    expect(response.status).toBe(201);
    const raw: unknown = await response.json();
    expect(raw).not.toHaveProperty("grants");
    const output = z
      .object({ id: z.string(), key: z.string(), scope: z.unknown() })
      .parse(raw);
    expect(output.scope).toEqual(issuedScope);
    return output;
  };
  await createProject();
  await createEnvironment();
  const original = await issue();
  const [ownedProject] = await db
    .select()
    .from(project)
    .where(eq(project.slug, slug));
  if (!ownedProject) {
    throw new Error("Created project not found");
  }
  const [ownedEnvironment] = await db
    .select()
    .from(environment)
    .where(eq(environment.projectId, ownedProject.id));
  const [row] = await db
    .select()
    .from(apikey)
    .where(eq(apikey.id, original.id));
  if (!(row?.metadata && ownedEnvironment)) {
    throw new Error("Issued metadata or environment not found");
  }
  expect(JSON.parse(row.metadata)).toEqual({
    ...issuedScope,
    grants: { [ownedProject.id]: { development: ownedEnvironment.id } },
  });
  const removed = await request(
    "DELETE",
    route.recreate === "project" ? projectPath : environmentPath,
    cookie
  );
  expect(removed.status).toBe(204);
  if (route.recreate === "project") {
    await createProject();
  }
  await createEnvironment();
  const seeded = await request(
    "PUT",
    `${environmentPath}/secrets/TOKEN`,
    cookie,
    {
      value: "recreated-value",
    }
  );
  expect(seeded.status).toBe(200);
  const before = await snapshotVault();
  const target = `${environmentPath}${route.suffix}`;
  const body = "body" in route ? route.body : undefined;
  await expectError(
    await keyRequest(original.key, target, route.method, body),
    403,
    "FORBIDDEN"
  );
  expect(await snapshotVault()).toEqual(before);
  const replacement = await issue();
  const allowed = await keyRequest(replacement.key, target, route.method, body);
  expect(allowed.status).toBe(route.status);
});
