import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createAuth } from "@jomans-vault/auth";
import {
  IntegrityError,
  MasterKeyError,
  parseMasterKey,
  unwrapDek,
} from "@jomans-vault/crypto";
import { createDb } from "@jomans-vault/db";
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
import { parse } from "dotenv";
import { and, asc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as z from "zod";

import { createContext } from "./context";
import { createVaultApiHandler } from "./handler";
import { generateOpenApiSpec } from "./openapi";
import { appRouter } from "./routers/index";

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
        // pool.end() resolves before its sockets close. FORCE would kill those
        // closing sessions and surface 57P01 as an unhandled error, so let
        // Postgres wait for them to exit instead.
        await admin.query(`DROP DATABASE "${databaseName}"`);
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
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
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
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({
    message: "This is private",
    user: { email },
  });
});

test("the served OpenAPI spec equals the docs generator output", async () => {
  const response = await handler(new Request(`${baseURL}/api/v1/spec.json`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(await generateOpenApiSpec());
});

test("the generated OpenAPI spec includes all REST operations", async () => {
  const response = await handler(new Request(`${baseURL}/api/v1/spec.json`));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    servers: [{ url: "/api/v1" }],
    paths: {
      "/health": { get: expect.any(Object) },
      "/private-data": { get: expect.any(Object) },
      "/projects": { get: expect.any(Object), post: expect.any(Object) },
      "/projects/{project}": {
        patch: expect.any(Object),
        delete: expect.any(Object),
      },
      "/projects/{project}/envs": {
        get: expect.any(Object),
        post: expect.any(Object),
      },
      "/projects/{project}/envs/{env}": { delete: expect.any(Object) },
      "/projects/{project}/envs/{env}/secrets": { get: expect.any(Object) },
      "/projects/{project}/envs/{env}/export": {
        get: {
          parameters: expect.arrayContaining([
            expect.objectContaining({
              name: "format",
              in: "query",
              schema: expect.objectContaining({ enum: ["json", "dotenv"] }),
            }),
          ]),
          responses: {
            "200": {
              content: {
                "application/json": expect.any(Object),
                "text/plain; charset=utf-8": expect.any(Object),
              },
            },
          },
        },
      },
      "/projects/{project}/envs/{env}/secrets/{key}": {
        get: expect.any(Object),
        put: expect.any(Object),
        patch: expect.any(Object),
        delete: expect.any(Object),
      },
      "/projects/{project}/envs/{env}/secrets/{key}/rollback": {
        post: expect.any(Object),
      },
      "/projects/{project}/envs/{env}/secrets/{key}/versions": {
        get: expect.any(Object),
      },
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

interface TestUser {
  cookie: string;
  id: string;
}
let userA: TestUser;
let userB: TestUser;
const requestMetadata = {
  "User-Agent": "Vault API test",
  "X-Forwarded-For": " 192.0.2.1 , 192.0.2.2",
  "X-Real-IP": "192.0.2.3",
};
const keyBytes = parseMasterKey(masterKey);

const signupUser = async (email: string): Promise<TestUser> => {
  const response = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseURL },
      body: JSON.stringify({
        email,
        password: crypto.randomUUID(),
        name: "Project Tester",
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

beforeAll(async () => {
  userA = await signupUser("project-a@example.com");
  userB = await signupUser("project-b@example.com");
});

const projectRequest = async (
  method: string,
  path = "",
  body?: unknown,
  cookie = userA.cookie
): Promise<Response> => {
  const response = await handler(
    new Request(`${baseURL}/api/v1/projects${path}`, {
      method,
      headers: {
        ...requestMetadata,
        cookie,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  return response;
};
const createProject = async (slug: string, cookie = userA.cookie) =>
  await projectRequest("POST", "", { slug, name: "Project" }, cookie);
const ownedRows = async (slug: string, ownerId = userA.id) =>
  await db
    .select()
    .from(project)
    .where(and(eq(project.slug, slug), eq(project.ownerId, ownerId)));
const keyRows = async (projectId: string) =>
  await db.select().from(projectKey).where(eq(projectKey.projectId, projectId));
const auditRows = async () => await db.select().from(auditEvent);
const publicProject = z.object({
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const expectPublicProject = (value: unknown, slug: string, name: string) => {
  const body = publicProject.parse(value);
  expect(Object.keys(body).toSorted()).toEqual([
    "createdAt",
    "name",
    "slug",
    "updatedAt",
  ]);
  expect(
    Object.keys(z.record(z.string(), z.unknown()).parse(value)).toSorted()
  ).toEqual(Object.keys(body).toSorted());
  expect(body).toMatchObject({ slug, name });
  for (const field of [body.createdAt, body.updatedAt]) {
    expect(new Date(field).toISOString()).toBe(field);
  }
  return body;
};
const eventCount = async () => {
  const rows = await auditRows();
  return rows.length;
};
const createStatus = async (...args: Parameters<typeof createProject>) => {
  const response = await createProject(...args);
  return response.status;
};
const requestStatus = async (...args: Parameters<typeof projectRequest>) => {
  const response = await projectRequest(...args);
  return response.status;
};
const listProjects = async (cookie = userA.cookie) => {
  const response = await projectRequest("GET", "", undefined, cookie);
  expect(response.status).toBe(200);
  return z.array(publicProject).parse(await response.json());
};
const firstRow = <T>(rows: T[]): T => {
  const [row] = rows;
  assert.ok(row);
  return row;
};

test("projects support create, list, rename, delete and slug reuse", async () => {
  const createResponse = await projectRequest("POST", "", {
    slug: "web-app",
    name: " Web App ",
  });
  expect(createResponse.status).toBe(201);
  const body = expectPublicProject(
    await createResponse.json(),
    "web-app",
    "Web App"
  );
  expect(await listProjects()).toContainEqual(body);
  const auditCount = await eventCount();
  const renamed = await projectRequest("PATCH", "/web-app", {
    name: "Renamed",
    slug: "other",
  });
  expect(renamed.status).toBe(200);
  const renamedBody = expectPublicProject(
    await renamed.json(),
    "web-app",
    "Renamed"
  );
  expect(Date.parse(renamedBody.updatedAt)).toBeGreaterThan(
    Date.parse(body.updatedAt)
  );
  expect(await eventCount()).toBe(auditCount);
  const deleted = await projectRequest("DELETE", "/web-app");
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe("");
  expect(await listProjects()).not.toContainEqual(renamedBody);
  expect(await requestStatus("PATCH", "/web-app", { name: "Gone" })).toBe(404);
  expect(await requestStatus("DELETE", "/web-app")).toBe(404);
  expect(await createStatus("web-app")).toBe(201);
});

test("lists are sorted and isolated by owner", async () => {
  expect(await listProjects(userB.cookie)).toEqual([]);
  expect(await createStatus("b-proj")).toBe(201);
  expect(await createStatus("a-proj")).toBe(201);
  const before = await eventCount();
  const list = await listProjects();
  const slugs = list.map((row: { slug: string }) => row.slug);
  expect(slugs).toEqual(slugs.toSorted());
  expect(slugs.indexOf("a-proj")).toBeLessThan(slugs.indexOf("b-proj"));
  expect(await listProjects(userB.cookie)).toEqual([]);
  expect(await eventCount()).toBe(before);
});

test("duplicate slugs conflict only within one owner", async () => {
  expect(await createStatus("duplicate")).toBe(201);
  const before = await eventCount();
  const duplicate = await createProject("duplicate");
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: "CONFLICT" });
  const rows = await ownedRows("duplicate");
  expect(rows).toHaveLength(1);
  expect(await keyRows(firstRow(rows).id)).toHaveLength(1);
  expect(await eventCount()).toBe(before);
  expect(await createStatus("duplicate", userB.cookie)).toBe(201);
});

test("concurrent duplicate creates persist one project, key and audit event", async () => {
  const before = await eventCount();
  const responses = await Promise.all([
    createProject("concurrent"),
    createProject("concurrent"),
  ]);
  expect(responses.map((response) => response.status).toSorted()).toEqual([
    201, 409,
  ]);
  const rows = await ownedRows("concurrent");
  expect(rows).toHaveLength(1);
  expect(await keyRows(firstRow(rows).id)).toHaveLength(1);
  expect(await eventCount()).toBe(before + 1);
});

test.each(["", "Web", "web_app", "web app", "wéb", "x".repeat(65)])(
  "invalid slug %j creates no rows or audit",
  async (slug) => {
    const before = await eventCount();
    const projectsBefore = await db.select().from(project);
    const keysBefore = await db.select().from(projectKey);
    const response = await createProject(slug);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "BAD_REQUEST" });
    expect(await db.select().from(project)).toEqual(projectsBefore);
    expect(await db.select().from(projectKey)).toEqual(keysBefore);
    expect(await eventCount()).toBe(before);
  }
);

test.each([
  { slug: "missing-name" },
  { slug: "blank-name", name: "   " },
  { slug: "long-name", name: "n".repeat(101) },
])("invalid create name for $slug writes nothing", async (input) => {
  const before = await eventCount();
  const response = await projectRequest("POST", "", input);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "BAD_REQUEST" });
  expect(await ownedRows(input.slug)).toEqual([]);
  expect(await eventCount()).toBe(before);
});

test("invalid rename name and delete path return BAD_REQUEST without audit", async () => {
  const before = await eventCount();
  const responses = [
    await projectRequest("PATCH", "/web-app", { name: "   " }),
    await projectRequest("DELETE", "/Web"),
  ];
  const bodies = await Promise.all(
    responses.map(async (response) => {
      expect(response.status).toBe(400);
      return await response.json();
    })
  );
  for (const body of bodies) {
    expect(body).toMatchObject({ code: "BAD_REQUEST" });
  }
  expect(await eventCount()).toBe(before);
});

test.each(["PATCH", "DELETE"])(
  "%s gives identical not-found responses for another owner and an absent project",
  async (method) => {
    const before = await eventCount();
    const body = method === "PATCH" ? { name: "Stolen" } : undefined;
    const notOwned = await projectRequest(
      method,
      "/web-app",
      body,
      userB.cookie
    );
    const nonexistent = await projectRequest(
      method,
      "/nobody-owns-this",
      body,
      userB.cookie
    );
    expect(notOwned.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    expect(await notOwned.text()).toBe(await nonexistent.text());
    expect(firstRow(await ownedRows("web-app")).name).toBe("Project");
    expect(await listProjects()).toContainEqual(
      expect.objectContaining({ slug: "web-app", name: "Project" })
    );
    expect(await eventCount()).toBe(before);
  }
);

test.each(
  ["", unknownCookie].flatMap((cookie) =>
    [
      { method: "GET", path: "" },
      { method: "POST", path: "" },
      { method: "PATCH", path: "/web-app" },
      { method: "DELETE", path: "/web-app" },
      { method: "PATCH", path: "/Web" },
      { method: "DELETE", path: "/Web" },
    ].map((route) => ({ cookie, ...route }))
  )
)(
  "unauthenticated $method projects$path rejects before invalid input or lookup",
  async ({ cookie, method, path }) => {
    const before = await eventCount();
    const projectsBefore = await db.select().from(project);
    const keysBefore = await db.select().from(projectKey);
    const baseline = await handler(
      new Request(`${baseURL}/api/v1/private-data`)
    );
    const response = await projectRequest(
      method,
      path,
      method === "POST" || method === "PATCH" ? {} : undefined,
      cookie
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(await baseline.text());
    expect(await db.select().from(project)).toEqual(projectsBefore);
    expect(await db.select().from(projectKey)).toEqual(keysBefore);
    expect(await eventCount()).toBe(before);
  }
);

test("data keys are wrapped and audit history survives deletion", async () => {
  const before = await eventCount();
  const response = await createProject("key-history");
  expect(response.status).toBe(201);
  const responseBody = await response.text();
  expectPublicProject(JSON.parse(responseBody), "key-history", "Project");
  const row = firstRow(await ownedRows("key-history"));
  const keys = await keyRows(row.id);
  expect(keys).toHaveLength(1);
  const key = firstRow(keys);
  expect(key.kekVersion).toBe(1);
  expect(await unwrapDek(key, keyBytes)).toHaveLength(32);
  await expect(
    unwrapDek(key, crypto.getRandomValues(new Uint8Array(32)))
  ).rejects.toBeInstanceOf(IntegrityError);
  for (const bytes of [key.wrappedDek, key.iv, keyBytes]) {
    expect(responseBody).not.toContain(Buffer.from(bytes).toString("base64"));
    expect(responseBody).not.toContain(Buffer.from(bytes).toString("hex"));
  }
  const events = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.projectId, row.id));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    action: "project.create",
    actorType: "user",
    actorId: userA.id,
    projectId: row.id,
    ip: "192.0.2.1",
    userAgent: "Vault API test",
    environmentId: null,
    secretId: null,
  });
  expect(await requestStatus("DELETE", "/key-history")).toBe(204);
  expect(await keyRows(row.id)).toHaveLength(0);
  const history = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.projectId, row.id));
  expect(history).toHaveLength(2);
  expect(history.map((event) => event.action).toSorted()).toEqual([
    "project.create",
    "project.delete",
  ]);
  for (const event of history) {
    expect(event).toMatchObject({
      actorType: "user",
      actorId: userA.id,
      projectId: row.id,
      ip: "192.0.2.1",
      userAgent: "Vault API test",
    });
    expect(event.apiKeyId).toBeNull();
    expect(Object.keys(event).toSorted()).toEqual([
      "action",
      "actorId",
      "actorType",
      "apiKeyId",
      "createdAt",
      "environmentId",
      "id",
      "ip",
      "projectId",
      "secretId",
      "userAgent",
    ]);
  }
  expect(await eventCount()).toBe(before + 2);
});

test("a rejected audit insert rolls back both create and delete with generic errors", async () => {
  expect(await createStatus("rollback-delete")).toBe(201);
  const existing = firstRow(await ownedRows("rollback-delete"));
  const before = await eventCount();
  const keysBefore = await db.select().from(projectKey);
  await db.execute(
    sql`ALTER TABLE audit_event ADD CONSTRAINT reject_all CHECK (false) NOT VALID`
  );
  try {
    const responses = [
      await createProject("rollback-create"),
      await projectRequest("DELETE", "/rollback-delete"),
    ];
    const bodies = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(500);
        return await response.json();
      })
    );
    for (const body of bodies) {
      expect(body).toEqual({
        defined: false,
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: "Internal server error",
      });
    }
    expect(await ownedRows("rollback-create")).toEqual([]);
    expect(await db.select().from(projectKey)).toEqual(keysBefore);
    expect(await ownedRows("rollback-delete")).toEqual([existing]);
    expect(await listProjects()).toContainEqual(
      expect.objectContaining({ slug: "rollback-delete" })
    );
    expect(await eventCount()).toBe(before);
  } finally {
    await db.execute(sql`ALTER TABLE audit_event DROP CONSTRAINT reject_all`);
  }
});

test("RPC projects.create shares the master key and projects with REST", async () => {
  const rpcHandler = new RPCHandler(appRouter);
  const link = new RPCLink({
    url: `${baseURL}/api/rpc`,
    headers: { cookie: userA.cookie },
    fetch: async (request) => {
      const { response } = await rpcHandler.handle(request, {
        prefix: "/api/rpc",
        context: await createContext({
          db,
          auth,
          headers: request.headers,
          masterKey: keyBytes,
        }),
      });
      return response ?? new Response("Not found", { status: 404 });
    },
  });
  const client: RouterClient<typeof appRouter> = createORPCClient(link);
  const result = await client.projects.create({
    slug: "rpc-project",
    name: "RPC Project",
  });
  expectPublicProject(result, "rpc-project", "RPC Project");
  expect(await listProjects()).toContainEqual(result);
  const row = firstRow(await ownedRows("rpc-project"));
  const keys = await keyRows(row.id);
  expect(keys).toHaveLength(1);
  expect(await unwrapDek(firstRow(keys), keyBytes)).toHaveLength(32);
});

test.each([
  {
    headers: new Headers({ "X-Real-IP": "192.0.2.4" }),
    ip: "192.0.2.4",
    userAgent: null,
  },
  { headers: new Headers(), ip: null, userAgent: null },
])(
  "context records fallback request metadata $ip",
  async ({ headers, ip, userAgent }) => {
    const context = await createContext({
      db,
      auth,
      headers,
      masterKey: keyBytes,
    });
    expect(context).toMatchObject({ ip, userAgent });
  }
);

const environmentRequest = async (
  method: string,
  projectSlug: string,
  path = "",
  body?: unknown,
  cookie = userA.cookie
) => await projectRequest(method, `/${projectSlug}/envs${path}`, body, cookie);
const secretRouteRequest = async (
  method: string,
  projectSlug: string,
  env: string,
  path: string,
  body?: unknown,
  cookie = userA.cookie
) =>
  await environmentRequest(
    method,
    projectSlug,
    `/${encodeURIComponent(env)}/secrets${path}`,
    body,
    cookie
  );
const secretMetadataRequest = async (
  projectSlug: string,
  env: string,
  key?: string
) =>
  await secretRouteRequest(
    "GET",
    projectSlug,
    env,
    key === undefined ? "" : `/${encodeURIComponent(key)}/versions`
  );
const secretRequest = async (
  method: string,
  projectSlug: string,
  env: string,
  key: string,
  body?: unknown,
  cookie = userA.cookie
) =>
  await secretRouteRequest(
    method,
    projectSlug,
    env,
    `/${encodeURIComponent(key)}`,
    body,
    cookie
  );
const createEnvironment = async (
  projectSlug: string,
  slug: string,
  cookie = userA.cookie
) => await environmentRequest("POST", projectSlug, "", { slug }, cookie);
const createEnvironmentStatus = async (
  ...args: Parameters<typeof createEnvironment>
) => {
  const response = await createEnvironment(...args);
  return response.status;
};
const environmentRequestStatus = async (
  ...args: Parameters<typeof environmentRequest>
) => {
  const response = await environmentRequest(...args);
  return response.status;
};
const environmentRows = async (projectId: string) =>
  await db
    .select()
    .from(environment)
    .where(eq(environment.projectId, projectId));
const publicEnvironment = z.strictObject({
  slug: z.string(),
  createdAt: z.iso.datetime(),
});
const expectPublicEnvironment = (value: unknown, slug: string) => {
  const body = publicEnvironment.parse(value);
  expect(Object.keys(body).toSorted()).toEqual(["createdAt", "slug"]);
  expect(body.slug).toBe(slug);
  expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
  return body;
};
const listEnvironments = async (projectSlug: string, cookie = userA.cookie) => {
  const response = await environmentRequest(
    "GET",
    projectSlug,
    "",
    undefined,
    cookie
  );
  expect(response.status).toBe(200);
  return z.array(publicEnvironment).parse(await response.json());
};

test("environments support create, ordered list, permanent delete and slug reuse", async () => {
  expect(await createStatus("env-lifecycle")).toBe(201);
  const slugs = ["development", "staging", "production", "qa-1"];
  await Promise.all(
    slugs.map(async (slug) => {
      const response = await createEnvironment("env-lifecycle", slug);
      expect(response.status).toBe(201);
      expectPublicEnvironment(await response.json(), slug);
    })
  );
  const before = await eventCount();
  const listed = await listEnvironments("env-lifecycle");
  expect(listed.map((row) => row.slug)).toEqual(slugs.toSorted());
  expect(await eventCount()).toBe(before);
  const deleted = await environmentRequest("DELETE", "env-lifecycle", "/qa-1");
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe("");
  const remaining = await listEnvironments("env-lifecycle");
  expect(remaining.map((row) => row.slug)).toEqual([
    "development",
    "production",
    "staging",
  ]);
  const projectRow = firstRow(await ownedRows("env-lifecycle"));
  const remainingRows = await environmentRows(projectRow.id);
  expect(remainingRows.map((row) => row.slug)).not.toContain("qa-1");
  const afterDelete = await eventCount();
  const missing = await environmentRequest("DELETE", "env-lifecycle", "/qa-1");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
  expect(await eventCount()).toBe(afterDelete);
  const recreated = await createEnvironment("env-lifecycle", "qa-1");
  expect(recreated.status).toBe(201);
  expectPublicEnvironment(await recreated.json(), "qa-1");
});

test("environment lists and lookups stay within their owned project", async () => {
  expect(await createStatus("env-scope")).toBe(201);
  expect(await createStatus("env-scope-other")).toBe(201);
  expect(await createStatus("env-scope", userB.cookie)).toBe(201);
  expect(await listEnvironments("env-scope")).toEqual([]);
  await Promise.all(
    [
      { projectSlug: "env-scope", slug: "own", cookie: userA.cookie },
      {
        projectSlug: "env-scope-other",
        slug: "other-project",
        cookie: userA.cookie,
      },
      { projectSlug: "env-scope", slug: "other-owner", cookie: userB.cookie },
    ].map(async ({ projectSlug, slug, cookie }) => {
      expect(await createEnvironmentStatus(projectSlug, slug, cookie)).toBe(
        201
      );
    })
  );
  const before = await eventCount();
  const listed = await listEnvironments("env-scope");
  expect(listed.map((row) => row.slug)).toEqual(["own"]);
  const rowsBefore = await db.select().from(environment);
  await Promise.all(
    ["other-project", "other-owner", "absent"].map(async (slug) => {
      const response = await environmentRequest(
        "DELETE",
        "env-scope",
        `/${slug}`
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    })
  );
  expect(await db.select().from(environment)).toEqual(rowsBefore);
  expect(await eventCount()).toBe(before);
});

test("environment duplicates conflict only within a project", async () => {
  expect(await createStatus("env-duplicates")).toBe(201);
  expect(await createStatus("env-duplicates-other")).toBe(201);
  expect(await createStatus("env-duplicates", userB.cookie)).toBe(201);
  expect(await createEnvironmentStatus("env-duplicates", "production")).toBe(
    201
  );
  const before = await eventCount();
  const duplicate = await createEnvironment("env-duplicates", "production");
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: "CONFLICT" });
  const row = firstRow(await ownedRows("env-duplicates"));
  expect(await environmentRows(row.id)).toHaveLength(1);
  expect(await eventCount()).toBe(before);
  await Promise.all(
    [
      { projectSlug: "env-duplicates-other", cookie: userA.cookie },
      { projectSlug: "env-duplicates", cookie: userB.cookie },
    ].map(async ({ projectSlug, cookie }) => {
      expect(
        await createEnvironmentStatus(projectSlug, "production", cookie)
      ).toBe(201);
    })
  );
});

test("concurrent duplicate creates persist one environment and audit event", async () => {
  expect(await createStatus("env-concurrent")).toBe(201);
  const before = await eventCount();
  const responses = await Promise.all([
    createEnvironment("env-concurrent", "production"),
    createEnvironment("env-concurrent", "production"),
  ]);
  expect(responses.map((response) => response.status).toSorted()).toEqual([
    201, 409,
  ]);
  const row = firstRow(await ownedRows("env-concurrent"));
  expect(await environmentRows(row.id)).toHaveLength(1);
  expect(await eventCount()).toBe(before + 1);
});

test("environment slugs accept the 64-character boundary", async () => {
  const slug = "x".repeat(64);
  const response = await createEnvironment("env-lifecycle", slug);
  expect(response.status).toBe(201);
  expectPublicEnvironment(await response.json(), slug);
  expect(
    await environmentRequestStatus("DELETE", "env-lifecycle", `/${slug}`)
  ).toBe(204);
});

test.each(["", "Prod", "my_env", "my env", "prød", "x".repeat(65)])(
  "invalid environment body slug %j writes no rows or audit",
  async (slug) => {
    const before = await eventCount();
    const rowsBefore = await db.select().from(environment);
    const response = await createEnvironment("env-lifecycle", slug);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "BAD_REQUEST" });
    expect(await db.select().from(environment)).toEqual(rowsBefore);
    expect(await eventCount()).toBe(before);
  }
);

test.each([
  { method: "DELETE", projectSlug: "env-lifecycle", path: "/Prod" },
  { method: "POST", projectSlug: "Prod", path: "" },
  { method: "GET", projectSlug: "Prod", path: "" },
  { method: "DELETE", projectSlug: "Prod", path: "/production" },
])(
  "invalid path on $method $projectSlug/envs$path writes nothing",
  async ({ method, projectSlug, path }) => {
    const before = await eventCount();
    const rowsBefore = await db.select().from(environment);
    const response = await environmentRequest(
      method,
      projectSlug,
      path,
      method === "POST" ? { slug: "production" } : undefined
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "BAD_REQUEST" });
    expect(await db.select().from(environment)).toEqual(rowsBefore);
    expect(await eventCount()).toBe(before);
  }
);

test.each(["POST", "GET", "DELETE"])(
  "%s environments gives identical not-found responses for unowned and absent projects",
  async (method) => {
    const before = await eventCount();
    const rowsBefore = await db.select().from(environment);
    const path = method === "DELETE" ? "/production" : "";
    const body = method === "POST" ? { slug: "production" } : undefined;
    const notOwned = await environmentRequest(
      method,
      "env-lifecycle",
      path,
      body,
      userB.cookie
    );
    const nonexistent = await environmentRequest(
      method,
      "nobody-owns-this",
      path,
      body,
      userB.cookie
    );
    expect(notOwned.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    expect(await notOwned.text()).toBe(await nonexistent.text());
    expect(await db.select().from(environment)).toEqual(rowsBefore);
    expect(await eventCount()).toBe(before);
  }
);

test.each(
  ["", unknownCookie].flatMap((cookie) =>
    [
      { method: "POST", projectSlug: "env-lifecycle", path: "" },
      { method: "GET", projectSlug: "env-lifecycle", path: "" },
      { method: "DELETE", projectSlug: "env-lifecycle", path: "/production" },
      { method: "POST", projectSlug: "Prod", path: "" },
      { method: "GET", projectSlug: "Prod", path: "" },
      { method: "DELETE", projectSlug: "Prod", path: "/Prod" },
      { method: "DELETE", projectSlug: "env-lifecycle", path: "/Prod" },
    ].map((route) => ({ cookie, ...route }))
  )
)(
  "unauthenticated $method $projectSlug/envs$path rejects before validation and lookup",
  async ({ cookie, method, projectSlug, path }) => {
    const before = await eventCount();
    const rowsBefore = await db.select().from(environment);
    const baseline = await handler(
      new Request(`${baseURL}/api/v1/private-data`)
    );
    const response = await environmentRequest(
      method,
      projectSlug,
      path,
      method === "POST" ? { slug: "Prod" } : undefined,
      cookie
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(await baseline.text());
    expect(await db.select().from(environment)).toEqual(rowsBefore);
    expect(await eventCount()).toBe(before);
  }
);

test("environment create and delete each record their internal audit target", async () => {
  expect(await createStatus("env-audit")).toBe(201);
  const projectRow = firstRow(await ownedRows("env-audit"));
  const before = await eventCount();
  expect(await createEnvironmentStatus("env-audit", "production")).toBe(201);
  const row = firstRow(await environmentRows(projectRow.id));
  expect(await eventCount()).toBe(before + 1);
  const events = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.environmentId, row.id));
  expect(events).toHaveLength(1);
  expect(firstRow(events).action).toBe("environment.create");
  expect(
    await environmentRequestStatus("DELETE", "env-audit", "/production")
  ).toBe(204);
  expect(await eventCount()).toBe(before + 2);
  expect(await environmentRows(projectRow.id)).toEqual([]);
  const history = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.environmentId, row.id));
  expect(history).toHaveLength(2);
  expect(history.map((event) => event.action).toSorted()).toEqual([
    "environment.create",
    "environment.delete",
  ]);
  for (const event of history) {
    expect(event).toMatchObject({
      actorType: "user",
      actorId: userA.id,
      projectId: projectRow.id,
      environmentId: row.id,
      secretId: null,
      ip: "192.0.2.1",
      userAgent: "Vault API test",
    });
  }
});

test("a rejected audit insert rolls back environment create and delete with generic errors", async () => {
  expect(await createStatus("env-rollback")).toBe(201);
  expect(await createEnvironmentStatus("env-rollback", "existing")).toBe(201);
  const rowsBefore = await db.select().from(environment);
  const before = await eventCount();
  await db.execute(
    sql`ALTER TABLE audit_event ADD CONSTRAINT reject_all CHECK (false) NOT VALID`
  );
  try {
    const responses = [
      await createEnvironment("env-rollback", "new"),
      await environmentRequest("DELETE", "env-rollback", "/existing"),
    ];
    const bodies = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(500);
        return await response.json();
      })
    );
    for (const body of bodies) {
      expect(body).toEqual({
        defined: false,
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: "Internal server error",
      });
    }
    expect(await db.select().from(environment)).toEqual(rowsBefore);
    expect(await eventCount()).toBe(before);
  } finally {
    await db.execute(sql`ALTER TABLE audit_event DROP CONSTRAINT reject_all`);
  }
});

test("project deletion cascades environments and retains all audit history", async () => {
  expect(await createStatus("env-cascade")).toBe(201);
  await Promise.all(
    ["development", "production"].map(async (slug) => {
      expect(await createEnvironmentStatus("env-cascade", slug)).toBe(201);
    })
  );
  const projectRow = firstRow(await ownedRows("env-cascade"));
  expect(await environmentRows(projectRow.id)).toHaveLength(2);
  const historyBefore = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.projectId, projectRow.id));
  expect(historyBefore).toHaveLength(3);
  const before = await eventCount();
  expect(await requestStatus("DELETE", "/env-cascade")).toBe(204);
  expect(await ownedRows("env-cascade")).toEqual([]);
  expect(await environmentRows(projectRow.id)).toEqual([]);
  const history = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.projectId, projectRow.id));
  expect(history).toHaveLength(4);
  expect(history).toEqual(expect.arrayContaining(historyBefore));
  expect(history.map((event) => event.action).toSorted()).toEqual([
    "environment.create",
    "environment.create",
    "project.create",
    "project.delete",
  ]);
  expect(await eventCount()).toBe(before + 1);
});

const secretRows = async (environmentId: string, key?: string) =>
  await db
    .select()
    .from(secret)
    .where(
      and(
        eq(secret.environmentId, environmentId),
        key === undefined ? undefined : eq(secret.key, key)
      )
    );
const versionRows = async (secretId: string) =>
  await db
    .select()
    .from(secretVersion)
    .where(eq(secretVersion.secretId, secretId))
    .orderBy(asc(secretVersion.version));
const secretState = async () => ({
  secrets: await db.select().from(secret).orderBy(asc(secret.id)),
  versions: await db
    .select()
    .from(secretVersion)
    .orderBy(asc(secretVersion.id)),
  events: await db.select().from(auditEvent).orderBy(asc(auditEvent.id)),
});
const createSecretScope = async (projectSlug: string, envs = ["dev"]) => {
  expect(await createStatus(projectSlug)).toBe(201);
  await Promise.all(
    envs.map(async (env) => {
      expect(await createEnvironmentStatus(projectSlug, env)).toBe(201);
    })
  );
  const projectRow = firstRow(await ownedRows(projectSlug));
  return {
    projectRow,
    environments: await environmentRows(projectRow.id),
  };
};
const secretSetOutput = z.object({
  key: z.string(),
  kind: z.string(),
  version: z.number(),
  updatedAt: z.string(),
});
const expectSet = async (
  response: Response,
  key: string,
  version: number,
  kind = "secret"
) => {
  expect(response.status).toBe(200);
  const raw = await response.json();
  const body = secretSetOutput.parse(raw);
  expect(
    Object.keys(z.record(z.string(), z.unknown()).parse(raw)).toSorted()
  ).toEqual(["key", "kind", "updatedAt", "version"]);
  expect(body).toMatchObject({ key, kind, version });
  expect(new Date(body.updatedAt).toISOString()).toBe(body.updatedAt);
  return body;
};
const genericError = {
  defined: false,
  code: "INTERNAL_SERVER_ERROR",
  status: 500,
  message: "Internal server error",
};
const integrityError = {
  ...genericError,
  message: "Secret integrity check failed",
};
const spyConsole = () =>
  (["log", "warn", "error"] as const).map((method) =>
    spyOn(console, method).mockImplementation(() => {
      // Capture arguments without printing secret fixtures on a regression.
    })
  );

test("secrets set and get three encrypted versions with exact public shapes", async () => {
  const { environments } = await createSecretScope("secret-vault", [
    "dev",
    "prod",
  ]);
  const dev = firstRow(environments.filter((row) => row.slug === "dev"));
  let updatedAt = "";
  /* oxlint-disable no-await-in-loop -- Each set must finish before checking its version and revealing it. */
  for (const [index, value] of ["one", "two", "three"].entries()) {
    const body = await expectSet(
      await secretRequest("PUT", "secret-vault", "dev", "API_URL", { value }),
      "API_URL",
      index + 1
    );
    if (updatedAt) {
      expect(Date.parse(body.updatedAt)).toBeGreaterThan(Date.parse(updatedAt));
    }
    ({ updatedAt } = body);
    const response = await secretRequest(
      "GET",
      "secret-vault",
      "dev",
      "API_URL"
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      key: "API_URL",
      value,
      version: index + 1,
    });
  }
  /* oxlint-enable no-await-in-loop */
  const rows = await secretRows(dev.id, "API_URL");
  expect(rows).toHaveLength(1);
  const row = firstRow(rows);
  const versions = await versionRows(row.id);
  expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
  expect(row.currentVersionId).toBe(firstRow(versions.slice(2)).id);
  for (const version of versions) {
    expect(version).toMatchObject({
      createdByType: "user",
      createdById: userA.id,
    });
  }
});

test("secret lists return only sorted live metadata in the scoped environment", async () => {
  await createSecretScope("secret-list", ["dev", "prod", "empty"]);
  await createSecretScope("secret-list-other");
  const values = ["PRIVATE_LIST_A", "PRIVATE_LIST_B"];
  const outputs = await Promise.all(
    [
      {
        projectSlug: "secret-list",
        env: "dev",
        key: "B_KEY",
        value: values[1],
      },
      {
        projectSlug: "secret-list",
        env: "dev",
        key: "A_KEY",
        value: values[0],
      },
      {
        projectSlug: "secret-list",
        env: "prod",
        key: "PROD",
        value: "private prod",
      },
      {
        projectSlug: "secret-list-other",
        env: "dev",
        key: "OTHER",
        value: "private other",
      },
    ].map(
      async ({ projectSlug, env, key, value }) =>
        await expectSet(
          await secretRequest("PUT", projectSlug, env, key, {
            value,
            kind: "env",
          }),
          key,
          1,
          "env"
        )
    )
  );
  const updated = await expectSet(
    await secretRequest("PUT", "secret-list", "dev", "B_KEY", {
      value: values[1],
    }),
    "B_KEY",
    2,
    "env"
  );
  const before = await secretState();
  const response = await secretMetadataRequest("secret-list", "dev");
  expect(response.status).toBe(200);
  const text = await response.text();
  for (const value of values) {
    expect(text).not.toContain(value);
  }
  const body = z
    .array(
      z.strictObject({
        key: z.string(),
        kind: z.enum(["secret", "env", "token"]),
        version: z.number(),
        updatedAt: z.iso.datetime(),
      })
    )
    .parse(JSON.parse(text));
  expect(body).toEqual([
    {
      key: "A_KEY",
      kind: "env",
      version: 1,
      updatedAt: firstRow(outputs.slice(1)).updatedAt,
    },
    {
      key: "B_KEY",
      kind: "env",
      version: 2,
      updatedAt: updated.updatedAt,
    },
  ]);
  for (const row of body) {
    expect(Object.keys(row).toSorted()).toEqual([
      "key",
      "kind",
      "updatedAt",
      "version",
    ]);
  }
  const empty = await secretMetadataRequest("secret-list", "empty");
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual([]);
  expect(await secretState()).toEqual(before);
});

test("secret removal preserves history, audits once and allows a new life at version one", async () => {
  const projectSlug = "secret-remove";
  const { projectRow, environments } = await createSecretScope(projectSlug);
  const dev = firstRow(environments);
  const firstValue = "PRIVATE_REMOVE_FIRST";
  const secondValue = "PRIVATE_REMOVE_SECOND";
  await expectSet(
    await secretRequest("PUT", projectSlug, "dev", "A_KEY", {
      value: firstValue,
    }),
    "A_KEY",
    1
  );
  await expectSet(
    await secretRequest("PUT", projectSlug, "dev", "A_KEY", {
      value: secondValue,
    }),
    "A_KEY",
    2
  );
  const row = firstRow(await secretRows(dev.id, "A_KEY"));
  const storedVersions = await versionRows(row.id);
  const beforeReads = await secretState();
  const history = await secretMetadataRequest(projectSlug, "dev", "A_KEY");
  expect(history.status).toBe(200);
  const historyText = await history.text();
  expect(historyText).not.toContain(firstValue);
  expect(historyText).not.toContain(secondValue);
  const historyBody = z
    .array(
      z.strictObject({
        version: z.number(),
        createdByType: z.string(),
        createdById: z.string(),
        createdAt: z.iso.datetime(),
      })
    )
    .parse(JSON.parse(historyText));
  expect(historyBody).toEqual(
    storedVersions.map((version) => ({
      version: version.version,
      createdByType: "user",
      createdById: userA.id,
      createdAt: version.createdAt.toISOString(),
    }))
  );
  expect(historyBody.map((version) => version.version)).toEqual([1, 2]);
  for (const version of historyBody) {
    expect(Object.keys(version).toSorted()).toEqual([
      "createdAt",
      "createdById",
      "createdByType",
      "version",
    ]);
  }
  expect(await secretState()).toEqual(beforeReads);
  const beforeDelete = await eventCount();
  const removed = await secretRequest("DELETE", projectSlug, "dev", "A_KEY");
  expect(removed.status).toBe(204);
  expect(await removed.text()).toBe("");
  expect(await eventCount()).toBe(beforeDelete + 1);
  const removedRow = firstRow(await secretRows(dev.id, "A_KEY"));
  expect(removedRow.deletedAt).toBeInstanceOf(Date);
  expect(removedRow).toEqual({ ...row, deletedAt: expect.any(Date) });
  expect(await versionRows(row.id)).toEqual(storedVersions);
  const events = await db
    .select()
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.secretId, row.id),
        eq(auditEvent.action, "secret.delete")
      )
    );
  expect(events).toHaveLength(1);
  expect(firstRow(events)).toMatchObject({
    action: "secret.delete",
    actorType: "user",
    actorId: userA.id,
    projectId: projectRow.id,
    environmentId: dev.id,
    secretId: row.id,
    ip: "192.0.2.1",
    userAgent: "Vault API test",
  });
  const afterDelete = await secretState();
  const listed = await secretMetadataRequest(projectSlug, "dev");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual([]);
  const removedHistory = await secretMetadataRequest(
    projectSlug,
    "dev",
    "A_KEY"
  );
  expect(removedHistory.status).toBe(200);
  expect(await removedHistory.json()).toEqual(historyBody);
  const failures = await Promise.all([
    secretRequest("GET", projectSlug, "dev", "A_KEY"),
    secretRequest("DELETE", projectSlug, "dev", "A_KEY"),
    secretRequest("DELETE", projectSlug, "dev", "NEVER_SET"),
    secretMetadataRequest(projectSlug, "dev", "NEVER_SET"),
  ]);
  for (const response of failures) {
    expect(response.status).toBe(404);
  }
  expect(await secretState()).toEqual(afterDelete);
  const newValue = "PRIVATE_REMOVE_NEW";
  await expectSet(
    await secretRequest("PUT", projectSlug, "dev", "A_KEY", {
      value: newValue,
    }),
    "A_KEY",
    1
  );
  const get = await secretRequest("GET", projectSlug, "dev", "A_KEY");
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual({
    key: "A_KEY",
    value: newValue,
    version: 1,
  });
  const beforeNewHistory = await secretState();
  const newHistory = await secretMetadataRequest(projectSlug, "dev", "A_KEY");
  expect(newHistory.status).toBe(200);
  expect(
    z
      .array(z.object({ version: z.number() }))
      .parse(await newHistory.json())
      .map((version) => version.version)
  ).toEqual([1]);
  expect(await secretState()).toEqual(beforeNewHistory);
  const rows = await secretRows(dev.id, "A_KEY");
  expect(rows).toHaveLength(2);
  expect(rows.find((item) => item.id === row.id)).toEqual(removedRow);
  const live = firstRow(rows.filter((item) => item.deletedAt === null));
  expect(await versionRows(live.id)).toHaveLength(1);
  expect(await versionRows(row.id)).toEqual(storedVersions);
  const allEvents = JSON.stringify(await auditRows());
  for (const value of [firstValue, secondValue, newValue]) {
    expect(allEvents).not.toContain(value);
  }
});

test("removed secret history uses removal time, creation time and id tie breakers", async () => {
  const projectSlug = "secret-history-order";
  const { environments } = await createSecretScope(projectSlug);
  const environmentId = firstRow(environments).id;
  const old = new Date("2025-01-01T00:00:00Z");
  const recent = new Date("2025-02-01T00:00:00Z");
  const rows = [
    { id: "history-z", deletedAt: old, createdAt: recent },
    { id: "history-y", deletedAt: recent, createdAt: old },
    { id: "history-a", deletedAt: recent, createdAt: recent },
    { id: "history-b", deletedAt: recent, createdAt: recent },
  ];
  await db.insert(secret).values(
    rows.map((row) => ({
      ...row,
      environmentId,
      key: "HISTORY",
      kind: "secret",
    }))
  );
  await db.insert(secretVersion).values(
    rows.map((row, index) => ({
      secretId: row.id,
      version: index + 1,
      ciphertext: Buffer.from("encrypted fixture"),
      iv: Buffer.alloc(12),
      createdByType: "user",
      createdById: userA.id,
    }))
  );
  const before = await secretState();
  const response = await secretMetadataRequest(projectSlug, "dev", "HISTORY");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    {
      version: 4,
      createdByType: "user",
      createdById: userA.id,
      createdAt: firstRow(
        await versionRows("history-b")
      ).createdAt.toISOString(),
    },
  ]);
  expect(await secretState()).toEqual(before);
});

test("concurrent secret removals change one row and write one audit event", async () => {
  const projectSlug = "secret-remove-race";
  const { environments } = await createSecretScope(projectSlug);
  await expectSet(
    await secretRequest("PUT", projectSlug, "dev", "RACE", {
      value: "private race",
    }),
    "RACE",
    1
  );
  const row = firstRow(await secretRows(firstRow(environments).id));
  const versions = await versionRows(row.id);
  const before = await eventCount();
  const responses = await Promise.all([
    secretRequest("DELETE", projectSlug, "dev", "RACE"),
    secretRequest("DELETE", projectSlug, "dev", "RACE"),
  ]);
  expect(responses.map((response) => response.status).toSorted()).toEqual([
    204, 404,
  ]);
  expect(await eventCount()).toBe(before + 1);
  expect(await versionRows(row.id)).toEqual(versions);
});

test.each(["lower", "1ABC", "BAD-KEY"])(
  "remove and history reject invalid key %s without writes",
  async (key) => {
    const before = await secretState();
    const responses = await Promise.all([
      secretRequest("DELETE", "secret-vault", "dev", key),
      secretMetadataRequest("secret-vault", "dev", key),
    ]);
    await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: "BAD_REQUEST" });
      })
    );
    expect(await secretState()).toEqual(before);
  }
);

test("secrets with the same key are isolated by environment and project", async () => {
  const { environments } = await createSecretScope("secret-other");
  const scopes = [
    { projectSlug: "secret-vault", env: "dev", value: "development" },
    { projectSlug: "secret-vault", env: "prod", value: "production" },
    { projectSlug: "secret-other", env: "dev", value: "other" },
  ];
  await Promise.all(
    scopes.map(async ({ projectSlug, env, value }) => {
      await expectSet(
        await secretRequest("PUT", projectSlug, env, "SCOPED", { value }),
        "SCOPED",
        1
      );
      const response = await secretRequest("GET", projectSlug, env, "SCOPED");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        key: "SCOPED",
        value,
        version: 1,
      });
    })
  );
  const rows = await db.select().from(secret).where(eq(secret.key, "SCOPED"));
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((row) => row.environmentId)).size).toBe(3);
  expect(await secretRows(firstRow(environments).id, "SCOPED")).toHaveLength(1);
});

test.each([
  "",
  "  padded  ",
  "line1\nline2",
  'quote " and = and #',
  "日本語 ✓",
  "\uFEFFleading BOM",
  "\u0000null\r\n",
])("secret value %j round-trips exactly", async (value) => {
  const response = await secretRequest("PUT", "secret-vault", "dev", "EXACT", {
    value,
  });
  expect(response.status).toBe(200);
  const get = await secretRequest("GET", "secret-vault", "dev", "EXACT");
  expect(get.status).toBe(200);
  const body = z.object({ value: z.string() }).parse(await get.json());
  expect(body.value).toBe(value);
  expect(new TextEncoder().encode(body.value)).toEqual(
    new TextEncoder().encode(value)
  );
});

test("secret kind and description defaults, preservation and clearing", async () => {
  const projectRow = firstRow(await ownedRows("secret-vault"));
  const envs = await environmentRows(projectRow.id);
  const dev = firstRow(envs.filter((row) => row.slug === "dev"));
  const updates = [
    {
      body: {
        value: "one",
        kind: "env",
        description: "Base URL",
        ignored: "field",
      },
      kind: "env",
      description: "Base URL",
    },
    { body: { value: "two" }, kind: "env", description: "Base URL" },
    {
      body: { value: "three", kind: "token" },
      kind: "token",
      description: "Base URL",
    },
    {
      body: { value: "four", description: "" },
      kind: "token",
      description: null,
    },
    {
      body: { value: "five", description: "  spaces  " },
      kind: "token",
      description: "  spaces  ",
    },
  ];
  /* oxlint-disable no-await-in-loop -- Each update verifies the metadata retained from the previous request. */
  for (const [index, update] of updates.entries()) {
    await expectSet(
      await secretRequest(
        "PUT",
        "secret-vault",
        "dev",
        "METADATA",
        update.body
      ),
      "METADATA",
      index + 1,
      update.kind
    );
    expect(firstRow(await secretRows(dev.id, "METADATA"))).toMatchObject({
      kind: update.kind,
      description: update.description,
    });
  }
  /* oxlint-enable no-await-in-loop */
  await expectSet(
    await secretRequest("PUT", "secret-vault", "dev", "DEFAULT_KIND", {
      value: "default",
    }),
    "DEFAULT_KIND",
    1
  );
  expect(firstRow(await secretRows(dev.id, "DEFAULT_KIND"))).toMatchObject({
    kind: "secret",
    description: null,
  });
});

test.each([
  { value: "PRIVATE_INVALID_MARKER", kind: "SECRET" },
  { value: "PRIVATE_INVALID_MARKER", kind: "password" },
  { value: "PRIVATE_INVALID_MARKER", kind: null },
  { value: "PRIVATE_INVALID_MARKER", description: "d".repeat(501) },
  { value: "PRIVATE_INVALID_MARKER", description: null },
  {},
  { value: 123 },
])(
  "invalid secret body %j writes nothing and does not echo input",
  async (body) => {
    const before = await secretState();
    const response = await secretRequest(
      "PUT",
      "secret-vault",
      "dev",
      "INVALID_BODY",
      body
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: "BAD_REQUEST" });
    expect(text).not.toContain("PRIVATE_INVALID_MARKER");
    expect(await secretState()).toEqual(before);
  }
);

test.each(
  ["api_url", "1API", "API-URL", "API URL", "ÄPI", "A".repeat(256)].flatMap(
    (key) => ["PUT", "GET"].map((method) => ({ key, method }))
  )
)(
  "invalid secret key on $method $key writes nothing",
  async ({ key, method }) => {
    const before = await secretState();
    const response = await secretRequest(
      method,
      "secret-vault",
      "dev",
      key,
      method === "PUT" ? { value: "PRIVATE_INVALID_KEY" } : undefined
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: "BAD_REQUEST" });
    expect(text).not.toContain("PRIVATE_INVALID_KEY");
    expect(await secretState()).toEqual(before);
  }
);

test.each(["_X", "A1_B", "A".repeat(255)])(
  "secret key %s is accepted",
  async (key) => {
    await expectSet(
      await secretRequest("PUT", "secret-vault", "dev", key, {
        value: "valid",
      }),
      key,
      1
    );
  }
);

test.each([
  { name: "ascii", value: "a".repeat(65_536) },
  { name: "multibyte", value: "é".repeat(32_768) },
])("a 65536-byte $name secret is accepted", async ({ value, name }) => {
  const key = name === "ascii" ? "ASCII_BOUNDARY" : "UTF8_BOUNDARY";
  await expectSet(
    await secretRequest("PUT", "secret-vault", "dev", key, { value }),
    key,
    1
  );
  const response = await secretRequest("GET", "secret-vault", "dev", key);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ key, value, version: 1 });
});

test.each([
  {
    name: "ascii",
    value: `PRIVATE_SIZE_MARKER${"a".repeat(65_537 - "PRIVATE_SIZE_MARKER".length)}`,
  },
  { name: "multibyte", value: `PRIVATE_SIZE_MARKER${"é".repeat(32_769)}` },
  { name: "lone surrogate", value: "PRIVATE_SIZE_MARKER\uD800" },
])("invalid $name secret value writes and logs nothing", async ({ value }) => {
  const before = await secretState();
  const logs = spyConsole();
  try {
    const response = await secretRequest(
      "PUT",
      "secret-vault",
      "dev",
      "INVALID_SIZE",
      { value }
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: "BAD_REQUEST" });
    expect(text).not.toContain("PRIVATE_SIZE_MARKER");
    expect(text).not.toContain(value);
    expect(await secretState()).toEqual(before);
    for (const log of logs) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        "PRIVATE_SIZE_MARKER"
      );
    }
  } finally {
    for (const log of logs) {
      log.mockRestore();
    }
  }
});

test("concurrent sets serialize both new and existing secret versions and audit writes", async () => {
  const { environments } = await createSecretScope("secret-concurrent");
  const dev = firstRow(environments);
  /* oxlint-disable no-await-in-loop -- The second race must start with the versions committed by the first race. */
  for (const expected of [
    [1, 2],
    [3, 4],
  ]) {
    const before = await eventCount();
    const responses = await Promise.all([
      secretRequest("PUT", "secret-concurrent", "dev", "RACE", {
        value: "first",
      }),
      secretRequest("PUT", "secret-concurrent", "dev", "RACE", {
        value: "second",
      }),
    ]);
    const bodies = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);
        return secretSetOutput.parse(await response.json());
      })
    );
    expect(bodies.map((body) => body.version).toSorted()).toEqual(expected);
    const rows = await secretRows(dev.id, "RACE");
    expect(rows).toHaveLength(1);
    const row = firstRow(rows);
    const versions = await versionRows(row.id);
    const lastVersion = firstRow(expected.slice(1));
    expect(versions.map((version) => version.version)).toEqual(
      lastVersion === 2 ? [1, 2] : [1, 2, 3, 4]
    );
    expect(row.currentVersionId).toBe(firstRow(versions.slice(-1)).id);
    expect(await eventCount()).toBe(before + 2);
    const events = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.secretId, row.id));
    expect(events).toHaveLength(lastVersion);
    expect(events.every((event) => event.action === "secret.write")).toBe(true);
  }
  /* oxlint-enable no-await-in-loop */
});

test.each([false, true])(
  "secret update times follow version order when an older transaction locks last (existing: %s)",
  async (existing) => {
    const projectSlug = `secret-time-${existing}`;
    const { environments } = await createSecretScope(projectSlug);
    const dev = firstRow(environments);
    if (existing) {
      await expectSet(
        await secretRequest("PUT", projectSlug, "dev", "TIMED", {
          value: "seed",
        }),
        "TIMED",
        1
      );
    }
    const lock = await db.$client.connect();
    let delayed: Promise<Response> | undefined;
    try {
      await db.execute(sql`
        CREATE FUNCTION delay_secret_set() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.key = 'TIMED' AND NEW.description = 'delayed' THEN
            PERFORM pg_advisory_xact_lock(22008);
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER delay_secret_set BEFORE INSERT ON secret
          FOR EACH ROW EXECUTE FUNCTION delay_secret_set();
      `);
      await lock.query("SELECT pg_advisory_lock(22008)");
      delayed = secretRequest("PUT", projectSlug, "dev", "TIMED", {
        value: "older transaction",
        description: "delayed",
      });
      let waiting = false;
      /* oxlint-disable no-await-in-loop -- Wait for the older HTTP transaction to reach the trigger before starting the newer one. */
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await db.$client.query(`
          SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = 0 AND objid = 22008 AND NOT granted
        `);
        waiting = result.rows.length > 0;
        if (waiting) {
          break;
        }
        await Bun.sleep(10);
      }
      /* oxlint-enable no-await-in-loop */
      expect(waiting).toBe(true);
      const newer = await expectSet(
        await secretRequest("PUT", projectSlug, "dev", "TIMED", {
          value: "newer transaction",
        }),
        "TIMED",
        existing ? 2 : 1
      );
      await lock.query("SELECT pg_advisory_unlock(22008)");
      const older = await expectSet(await delayed, "TIMED", newer.version + 1);
      expect(Date.parse(older.updatedAt)).toBeGreaterThanOrEqual(
        Date.parse(newer.updatedAt)
      );
      const row = firstRow(await secretRows(dev.id, "TIMED"));
      expect(row.updatedAt.toISOString()).toBe(older.updatedAt);
      const versions = await versionRows(row.id);
      expect(row.currentVersionId).toBe(firstRow(versions.slice(-1)).id);
      const response = await secretRequest("GET", projectSlug, "dev", "TIMED");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        key: "TIMED",
        value: "older transaction",
        version: older.version,
      });
    } finally {
      await lock.query("SELECT pg_advisory_unlock_all()");
      await delayed;
      await db.execute(sql`
        DROP TRIGGER IF EXISTS delay_secret_set ON secret;
        DROP FUNCTION IF EXISTS delay_secret_set();
      `);
      lock.release();
    }
  }
);

test("plaintext never reaches stored text or bytea columns and repeated values use fresh IVs", async () => {
  const { projectRow, environments } =
    await createSecretScope("secret-at-rest");
  const value = `PRIVATE_AT_REST_${crypto.randomUUID()}`;
  /* oxlint-disable no-await-in-loop -- Repeated sets of one key must commit in version order. */
  for (const version of [1, 2]) {
    await expectSet(
      await secretRequest("PUT", "secret-at-rest", "dev", "PRIVATE", { value }),
      "PRIVATE",
      version
    );
  }
  /* oxlint-enable no-await-in-loop */
  const row = firstRow(await secretRows(firstRow(environments).id));
  const versions = await versionRows(row.id);
  expect(firstRow(versions).iv).not.toEqual(versions[1]?.iv);
  expect(firstRow(versions).ciphertext).not.toEqual(versions[1]?.ciphertext);
  await Promise.all(
    [secret, secretVersion, projectKey, auditEvent].map(async (table) => {
      const result = await db.execute(
        sql`SELECT row_to_json(t)::text AS text FROM ${table} AS t`
      );
      assert.ok(!Array.isArray(result));
      for (const stored of result.rows) {
        expect(z.object({ text: z.string() }).parse(stored).text).not.toContain(
          value
        );
      }
    })
  );
  const bytes = await db.execute(sql`
    SELECT position(convert_to(${value}, 'UTF8') in ciphertext) AS ciphertext,
      position(convert_to(${value}, 'UTF8') in iv) AS iv FROM secret_version
    UNION ALL
    SELECT position(convert_to(${value}, 'UTF8') in wrapped_dek),
      position(convert_to(${value}, 'UTF8') in iv) FROM project_key
  `);
  assert.ok(!Array.isArray(bytes));
  for (const stored of bytes.rows) {
    expect(stored).toEqual({ ciphertext: 0, iv: 0 });
  }
  expect(await keyRows(projectRow.id)).toHaveLength(1);
});

test.each(["ciphertext", "iv"] as const)(
  "tampering with secret %s returns the fixed integrity 500 without audit or logs",
  async (column) => {
    const projectSlug = `secret-tamper-${column}`;
    const { environments } = await createSecretScope(projectSlug);
    const value = `PRIVATE_TAMPER_${crypto.randomUUID()}`;
    await expectSet(
      await secretRequest("PUT", projectSlug, "dev", "TAMPER", { value }),
      "TAMPER",
      1
    );
    const row = firstRow(await secretRows(firstRow(environments).id));
    const field = secretVersion[column];
    await db.execute(
      sql`UPDATE secret_version SET ${sql.identifier(column)} = set_byte(${field}, 0, get_byte(${field}, 0) # 1) WHERE id = ${row.currentVersionId}`
    );
    const before = await secretState();
    const logs = spyConsole();
    try {
      const response = await secretRequest("GET", projectSlug, "dev", "TAMPER");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(integrityError);
      expect(await secretState()).toEqual(before);
      for (const log of logs) {
        expect(JSON.stringify(log.mock.calls)).not.toContain(value);
        expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_TAMPER_");
      }
    } finally {
      for (const log of logs) {
        log.mockRestore();
      }
    }
  }
);

test.each(["PUT", "GET"])(
  "a tampered wrapped data key returns the fixed integrity 500 on %s",
  async (method) => {
    const projectSlug = `secret-dek-${method.toLowerCase()}`;
    const { projectRow } = await createSecretScope(projectSlug);
    await expectSet(
      await secretRequest("PUT", projectSlug, "dev", "DEK", {
        value: "PRIVATE_DEK_MARKER",
      }),
      "DEK",
      1
    );
    await db.execute(
      sql`UPDATE project_key SET wrapped_dek = set_byte(wrapped_dek, 0, get_byte(wrapped_dek, 0) # 1) WHERE project_id = ${projectRow.id}`
    );
    const before = await secretState();
    const response = await secretRequest(
      method,
      projectSlug,
      "dev",
      "DEK",
      method === "PUT" ? { value: "PRIVATE_DEK_MARKER" } : undefined
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(integrityError);
    expect(await secretState()).toEqual(before);
  }
);

test.each(["PUT", "GET"])(
  "a missing project data key returns a generic 500 on %s without writes",
  async (method) => {
    const projectSlug = `secret-no-key-${method.toLowerCase()}`;
    const { projectRow } = await createSecretScope(projectSlug);
    await expectSet(
      await secretRequest("PUT", projectSlug, "dev", "KEY", {
        value: "PRIVATE_MISSING_KEY",
      }),
      "KEY",
      1
    );
    await db.delete(projectKey).where(eq(projectKey.projectId, projectRow.id));
    const before = await secretState();
    const response = await secretRequest(
      method,
      projectSlug,
      "dev",
      "KEY",
      method === "PUT" ? { value: "PRIVATE_MISSING_KEY" } : undefined
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(genericError);
    expect(await secretState()).toEqual(before);
  }
);

test("secret write and reveal each record exactly one internal audit target", async () => {
  const { projectRow, environments } = await createSecretScope("secret-audit");
  const dev = firstRow(environments);
  const before = await eventCount();
  await expectSet(
    await secretRequest("PUT", "secret-audit", "dev", "AUDITED", {
      value: "private",
    }),
    "AUDITED",
    1
  );
  expect(await eventCount()).toBe(before + 1);
  const row = firstRow(await secretRows(dev.id));
  let events = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.secretId, row.id));
  expect(events).toHaveLength(1);
  expect(firstRow(events).action).toBe("secret.write");
  const response = await secretRequest("GET", "secret-audit", "dev", "AUDITED");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    key: "AUDITED",
    value: "private",
    version: 1,
  });
  expect(await eventCount()).toBe(before + 2);
  events = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.secretId, row.id));
  expect(events).toHaveLength(2);
  expect(events.map((event) => event.action).toSorted()).toEqual([
    "secret.reveal",
    "secret.write",
  ]);
  for (const event of events) {
    expect(event).toMatchObject({
      actorType: "user",
      actorId: userA.id,
      projectId: projectRow.id,
      environmentId: dev.id,
      secretId: row.id,
      ip: "192.0.2.1",
      userAgent: "Vault API test",
    });
  }
});

test("a rejected audit insert rolls back secret sets and removals and suppresses revealed values and logs", async () => {
  await createSecretScope("secret-rollback");
  const value = `PRIVATE_ROLLBACK_${crypto.randomUUID()}`;
  await expectSet(
    await secretRequest("PUT", "secret-rollback", "dev", "EXISTING", { value }),
    "EXISTING",
    1
  );
  const before = await secretState();
  await db.execute(
    sql`ALTER TABLE audit_event ADD CONSTRAINT reject_all CHECK (false) NOT VALID`
  );
  const logs = spyConsole();
  try {
    const responses = [
      await secretRequest("PUT", "secret-rollback", "dev", "NEW", { value }),
      await secretRequest("PUT", "secret-rollback", "dev", "EXISTING", {
        value: `${value}_updated`,
      }),
      await secretRequest("PATCH", "secret-rollback", "dev", "EXISTING", {
        value,
        expectedVersion: 1,
      }),
      await secretRouteRequest(
        "POST",
        "secret-rollback",
        "dev",
        "/EXISTING/rollback",
        {
          version: 1,
        }
      ),
      await secretRequest("GET", "secret-rollback", "dev", "EXISTING"),
      await secretRequest("DELETE", "secret-rollback", "dev", "EXISTING"),
    ];
    for (const response of responses) {
      expect(response.status).toBe(500);
    }
    const texts = await Promise.all(
      responses.map(async (response) => await response.text())
    );
    for (const text of texts) {
      expect(text).not.toContain(value);
      expect(JSON.parse(text)).toEqual(genericError);
    }
    expect(await secretState()).toEqual(before);
    for (const log of logs) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(value);
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_ROLLBACK_");
    }
  } finally {
    for (const log of logs) {
      log.mockRestore();
    }
    await db.execute(sql`ALTER TABLE audit_event DROP CONSTRAINT reject_all`);
  }
});

const secretAccessRoutes = [
  { method: "PUT", path: "/API_URL", body: { value: "PRIVATE_SCOPE_MARKER" } },
  {
    method: "PATCH",
    path: "/API_URL",
    body: { value: "PRIVATE_SCOPE_MARKER", expectedVersion: 1 },
  },
  { method: "POST", path: "/API_URL/rollback", body: { version: 1 } },
  { method: "GET", path: "/API_URL", body: undefined },
  { method: "DELETE", path: "/API_URL", body: undefined },
  { method: "GET", path: "", body: undefined },
  { method: "GET", path: "/API_URL/versions", body: undefined },
];

test.each(secretAccessRoutes)(
  "$method secrets$path hides unowned projects with byte-identical 404s",
  async ({ method, path, body }) => {
    const before = await secretState();
    const notOwned = await secretRouteRequest(
      method,
      "secret-vault",
      "dev",
      path,
      body,
      userB.cookie
    );
    const absent = await secretRouteRequest(
      method,
      "nobody-owns-this",
      "dev",
      path,
      body,
      userB.cookie
    );
    expect(notOwned.status).toBe(404);
    expect(absent.status).toBe(404);
    const text = await notOwned.text();
    expect(JSON.parse(text)).toMatchObject({ code: "NOT_FOUND" });
    expect(text).toBe(await absent.text());
    expect(await secretState()).toEqual(before);
  }
);

test.each([
  ...secretAccessRoutes.map((route) => ({ ...route, env: "missing" })),
  { method: "GET", env: "dev", path: "/NEVER_SET", body: undefined },
  { method: "DELETE", env: "dev", path: "/NEVER_SET", body: undefined },
  { method: "GET", env: "dev", path: "/NEVER_SET/versions", body: undefined },
])(
  "$method on absent $env/secrets$path returns 404 without writes",
  async ({ method, env, path, body }) => {
    const before = await secretState();
    const response = await secretRouteRequest(
      method,
      "secret-vault",
      env,
      path,
      body
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      defined: false,
      code: "NOT_FOUND",
      status: 404,
      message: "Not Found",
    });
    expect(await secretState()).toEqual(before);
  }
);

test.each(
  secretAccessRoutes.flatMap((route) => [
    { ...route, projectSlug: "Bad", env: "dev" },
    { ...route, projectSlug: "secret-vault", env: "Bad" },
  ])
)(
  "$method invalid secret scope $projectSlug/$env$path returns 400 without writes",
  async ({ method, projectSlug, env, path, body }) => {
    const before = await secretState();
    const response = await secretRouteRequest(
      method,
      projectSlug,
      env,
      path,
      body
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: "BAD_REQUEST" });
    expect(text).not.toContain("PRIVATE_SCOPE_MARKER");
    expect(await secretState()).toEqual(before);
  }
);

test.each(
  ["", unknownCookie].flatMap((cookie) =>
    secretAccessRoutes.flatMap((route) =>
      [
        { projectSlug: "secret-vault", env: "dev", path: route.path },
        { projectSlug: "Bad", env: "dev", path: route.path },
        { projectSlug: "secret-vault", env: "Bad", path: route.path },
        {
          projectSlug: "secret-vault",
          env: "dev",
          path: route.path.replace("API_URL", "bad"),
        },
      ].map((path) => ({
        cookie,
        method: route.method,
        body: route.body,
        ...path,
      }))
    )
  )
)(
  "unauthenticated $method secret $projectSlug/$env$path rejects before validation or lookup",
  async ({ cookie, method, projectSlug, env, path, body }) => {
    const before = await secretState();
    const baseline = await handler(
      new Request(`${baseURL}/api/v1/private-data`)
    );
    const response = await secretRouteRequest(
      method,
      projectSlug,
      env,
      path,
      body === undefined ? undefined : {},
      cookie
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(await baseline.text());
    expect(await secretState()).toEqual(before);
  }
);

test.each(["environment", "project"])(
  "%s deletion cascades secret versions and retains secret audit history",
  async (target) => {
    const projectSlug = `secret-cascade-${target}`;
    const { projectRow, environments } = await createSecretScope(projectSlug, [
      "dev",
      "prod",
    ]);
    const dev = firstRow(environments.filter((row) => row.slug === "dev"));
    await Promise.all(
      ["dev", "prod"].flatMap((env) =>
        ["FIRST", "SECOND"].map(async (key) => {
          await expectSet(
            await secretRequest("PUT", projectSlug, env, key, {
              value: "private",
            }),
            key,
            1
          );
          const get = await secretRequest("GET", projectSlug, env, key);
          expect(get.status).toBe(200);
        })
      )
    );
    const allSecrets = await db.select().from(secret);
    const scopedSecrets = allSecrets.filter((row) =>
      environments.some((env) => env.id === row.environmentId)
    );
    const deletedSecrets =
      target === "project"
        ? scopedSecrets
        : scopedSecrets.filter((row) => row.environmentId === dev.id);
    const deletedIds = new Set(deletedSecrets.map((row) => row.id));
    const eventsBefore = await auditRows();
    const historyBefore = eventsBefore.filter(
      (event) => event.projectId === projectRow.id
    );
    expect(
      historyBefore.filter((event) => event.action.startsWith("secret."))
    ).toHaveLength(8);
    const response =
      target === "project"
        ? await projectRequest("DELETE", `/${projectSlug}`)
        : await environmentRequest("DELETE", projectSlug, "/dev");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const remainingSecrets = await db.select().from(secret);
    const remainingVersions = await db.select().from(secretVersion);
    expect(remainingSecrets.some((row) => deletedIds.has(row.id))).toBe(false);
    expect(remainingVersions.some((row) => deletedIds.has(row.secretId))).toBe(
      false
    );
    const events = await auditRows();
    const history = events.filter((event) => event.projectId === projectRow.id);
    expect(history).toHaveLength(historyBefore.length + 1);
    expect(history).toEqual(expect.arrayContaining(historyBefore));
    if (target === "environment") {
      const prod = firstRow(environments.filter((row) => row.slug === "prod"));
      expect(await secretRows(prod.id)).toHaveLength(2);
      const get = await secretRequest("GET", projectSlug, "prod", "FIRST");
      expect(get.status).toBe(200);
    } else {
      expect(await environmentRows(projectRow.id)).toEqual([]);
    }
  }
);

const rollbackSecret = async (
  projectSlug: string,
  key: string,
  version: number
) =>
  await secretRouteRequest("POST", projectSlug, "dev", `/${key}/rollback`, {
    version,
  });

const createVersionedSecret = async (projectSlug: string) => {
  const scope = await createSecretScope(projectSlug);
  await expectSet(
    await secretRequest("PUT", projectSlug, "dev", "KEY", { value: "A" }),
    "KEY",
    1
  );
  await expectSet(
    await secretRequest("PUT", projectSlug, "dev", "KEY", { value: "B" }),
    "KEY",
    2
  );
  return {
    ...scope,
    row: firstRow(await secretRows(firstRow(scope.environments).id, "KEY")),
  };
};

test("safe update preserves metadata, audits once and rejects stale or absent versions without writes", async () => {
  const projectSlug = "safe-update";
  const { projectRow, environments } = await createSecretScope(projectSlug);
  const dev = firstRow(environments);
  const initial = await expectSet(
    await secretRequest("PUT", projectSlug, "dev", "KEY", {
      value: "v1",
      kind: "token",
      description: "unchanged",
    }),
    "KEY",
    1,
    "token"
  );
  const before = await eventCount();
  const updated = await expectSet(
    await secretRequest("PATCH", projectSlug, "dev", "KEY", {
      value: "v2",
      expectedVersion: 1,
      kind: "env",
      description: "ignored",
    }),
    "KEY",
    2,
    "token"
  );
  expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(
    Date.parse(initial.updatedAt)
  );
  const row = firstRow(await secretRows(dev.id, "KEY"));
  expect(row).toMatchObject({ kind: "token", description: "unchanged" });
  const versions = await versionRows(row.id);
  expect(versions[1]).toMatchObject({
    createdByType: "user",
    createdById: userA.id,
  });
  expect(row.currentVersionId).toBe(firstRow(versions.slice(1)).id);
  expect(await eventCount()).toBe(before + 1);
  const events = await db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.secretId, row.id));
  expect(
    events.filter((event) => event.action === "secret.write")
  ).toHaveLength(2);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actorType: "user",
        actorId: userA.id,
        projectId: projectRow.id,
        environmentId: dev.id,
        secretId: row.id,
        action: "secret.write",
      }),
    ])
  );
  const get = await secretRequest("GET", projectSlug, "dev", "KEY");
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual({ key: "KEY", value: "v2", version: 2 });
  const state = await secretState();
  const stale = await secretRequest("PATCH", projectSlug, "dev", "KEY", {
    value: "stale",
    expectedVersion: 1,
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({
    defined: false,
    code: "CONFLICT",
    status: 409,
    message: "Conflict",
  });
  const absent = await secretRequest("PATCH", projectSlug, "dev", "NEVER_SET", {
    value: "missing",
    expectedVersion: 1,
  });
  expect(absent.status).toBe(404);
  expect(await secretState()).toEqual(state);
  const deletion = await secretRequest("DELETE", projectSlug, "dev", "KEY");
  expect(deletion.status).toBe(204);
  const removed = await secretState();
  const removedPatch = await secretRequest("PATCH", projectSlug, "dev", "KEY", {
    value: "removed",
    expectedVersion: 2,
  });
  expect(removedPatch.status).toBe(404);
  expect(await secretState()).toEqual(removed);
});

test("two safe updates with the same expected version commit exactly one version and audit event", async () => {
  const projectSlug = "safe-update-race";
  const { row } = await createVersionedSecret(projectSlug);
  const before = await eventCount();
  const responses = await Promise.all(
    ["C", "D"].map(
      async (value) =>
        await secretRequest("PATCH", projectSlug, "dev", "KEY", {
          value,
          expectedVersion: 2,
        })
    )
  );
  expect(responses.map((response) => response.status).toSorted()).toEqual([
    200, 409,
  ]);
  const versions = await versionRows(row.id);
  expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
  const updated = firstRow(await secretRows(row.environmentId, "KEY"));
  expect(updated.currentVersionId).toBe(firstRow(versions.slice(2)).id);
  expect(await eventCount()).toBe(before + 1);
});

test.each([1, 2])(
  "rollback to version %s copies ciphertext, extends history and audits the caller",
  async (version) => {
    const projectSlug = `rollback-live-${version}`;
    const { row, projectRow } = await createVersionedSecret(projectSlug);
    const original = await versionRows(row.id);
    const before = await eventCount();
    const result = await expectSet(
      await rollbackSecret(projectSlug, "KEY", version),
      "KEY",
      3
    );
    expect(Date.parse(result.updatedAt)).toBeGreaterThanOrEqual(
      row.updatedAt.getTime()
    );
    const versions = await versionRows(row.id);
    expect(versions.map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(versions[2]).toMatchObject({
      ciphertext: original[version - 1]?.ciphertext,
      iv: original[version - 1]?.iv,
      createdByType: "user",
      createdById: userA.id,
    });
    const updated = firstRow(await secretRows(row.environmentId, "KEY"));
    expect(updated.currentVersionId).toBe(firstRow(versions.slice(2)).id);
    expect(await eventCount()).toBe(before + 1);
    const events = await db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.secretId, row.id),
          eq(auditEvent.action, "secret.rollback")
        )
      );
    expect(events).toHaveLength(1);
    expect(firstRow(events)).toMatchObject({
      actorType: "user",
      actorId: userA.id,
      projectId: projectRow.id,
      environmentId: row.environmentId,
      secretId: row.id,
    });
    const history = await secretMetadataRequest(projectSlug, "dev", "KEY");
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual(
      versions.map((entry) => ({
        version: entry.version,
        createdByType: entry.createdByType,
        createdById: entry.createdById,
        createdAt: entry.createdAt.toISOString(),
      }))
    );
    const get = await secretRequest("GET", projectSlug, "dev", "KEY");
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      key: "KEY",
      value: version === 1 ? "A" : "B",
      version: 3,
    });
    const state = await secretState();
    const missingVersion = await rollbackSecret(projectSlug, "KEY", 9);
    const missingKey = await rollbackSecret(projectSlug, "NEVER_SET", 1);
    expect(missingVersion.status).toBe(404);
    expect(missingKey.status).toBe(404);
    expect(await secretState()).toEqual(state);
  }
);

test("rollback restores the original removed row and makes it visible again", async () => {
  const projectSlug = "rollback-removed";
  const { row } = await createVersionedSecret(projectSlug);
  const deletion = await secretRequest("DELETE", projectSlug, "dev", "KEY");
  expect(deletion.status).toBe(204);
  await expectSet(await rollbackSecret(projectSlug, "KEY", 2), "KEY", 3);
  const rows = await secretRows(row.environmentId, "KEY");
  expect(rows).toHaveLength(1);
  expect(firstRow(rows)).toMatchObject({ id: row.id, deletedAt: null });
  expect(await versionRows(row.id)).toHaveLength(3);
  const list = await secretMetadataRequest(projectSlug, "dev");
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual([
    expect.objectContaining({ key: "KEY", version: 3 }),
  ]);
  const get = await secretRequest("GET", projectSlug, "dev", "KEY");
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual({ key: "KEY", value: "B", version: 3 });
  const history = await secretMetadataRequest(projectSlug, "dev", "KEY");
  expect(await history.json()).toHaveLength(3);
});

test("rollback uses live history rather than a removed life of the same key", async () => {
  const projectSlug = "rollback-new-life";
  const { row } = await createVersionedSecret(projectSlug);
  const deletion = await secretRequest("DELETE", projectSlug, "dev", "KEY");
  expect(deletion.status).toBe(204);
  const removed = firstRow(await secretRows(row.environmentId, "KEY"));
  const oldVersions = await versionRows(row.id);
  await expectSet(
    await secretRequest("PUT", projectSlug, "dev", "KEY", { value: "fresh" }),
    "KEY",
    1
  );
  const state = await secretState();
  const missingVersion = await rollbackSecret(projectSlug, "KEY", 2);
  expect(missingVersion.status).toBe(404);
  expect(await secretState()).toEqual(state);
  await expectSet(await rollbackSecret(projectSlug, "KEY", 1), "KEY", 2);
  const rows = await secretRows(row.environmentId, "KEY");
  expect(rows.find((entry) => entry.id === row.id)).toEqual(removed);
  expect(await versionRows(row.id)).toEqual(oldVersions);
  const live = firstRow(rows.filter((entry) => entry.deletedAt === null));
  expect(live.id).not.toBe(row.id);
  expect(await versionRows(live.id)).toHaveLength(2);
});

test("two rollbacks of a removed key both serialize on the original row", async () => {
  const projectSlug = "rollback-removed-race";
  const { row } = await createVersionedSecret(projectSlug);
  const deletion = await secretRequest("DELETE", projectSlug, "dev", "KEY");
  expect(deletion.status).toBe(204);
  const before = await eventCount();
  const responses = await Promise.all([
    rollbackSecret(projectSlug, "KEY", 1),
    rollbackSecret(projectSlug, "KEY", 1),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const bodies = await Promise.all(
    responses.map(async (response) =>
      secretSetOutput.parse(await response.json())
    )
  );
  expect(bodies.map((body) => body.version).toSorted()).toEqual([3, 4]);
  const rows = await secretRows(row.environmentId, "KEY");
  expect(rows).toHaveLength(1);
  expect(firstRow(rows)).toMatchObject({ id: row.id, deletedAt: null });
  const versions = await versionRows(row.id);
  expect(versions.map((entry) => entry.version)).toEqual([1, 2, 3, 4]);
  expect(await eventCount()).toBe(before + 2);
  const events = await db
    .select()
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.secretId, row.id),
        eq(auditEvent.action, "secret.rollback")
      )
    );
  expect(events).toHaveLength(2);
});

test("a restore that loses to a fresh set returns conflict and rolls back all writes", async () => {
  const projectSlug = "rollback-set-race";
  const { row } = await createVersionedSecret(projectSlug);
  const deletion = await secretRequest("DELETE", projectSlug, "dev", "KEY");
  expect(deletion.status).toBe(204);
  const removed = firstRow(await secretRows(row.environmentId, "KEY"));
  const versions = await versionRows(row.id);
  const before = await eventCount();
  const lock = await db.$client.connect();
  let delayed: Promise<Response> | undefined;
  try {
    await db.execute(sql`
      CREATE FUNCTION delay_secret_restore() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
          PERFORM pg_advisory_xact_lock(22026);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER delay_secret_restore BEFORE UPDATE ON secret
        FOR EACH ROW EXECUTE FUNCTION delay_secret_restore();
    `);
    await lock.query("SELECT pg_advisory_lock(22026)");
    delayed = rollbackSecret(projectSlug, "KEY", 1);
    let waiting = false;
    /* oxlint-disable no-await-in-loop -- Observe the restore blocked in its trigger before issuing the competing set. */
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await db.$client.query(`
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = 0 AND objid = 22026 AND NOT granted
      `);
      waiting = result.rows.length > 0;
      if (waiting) {
        break;
      }
      await Bun.sleep(10);
    }
    /* oxlint-enable no-await-in-loop */
    expect(waiting).toBe(true);
    await expectSet(
      await secretRequest("PUT", projectSlug, "dev", "KEY", {
        value: "new life",
      }),
      "KEY",
      1
    );
    await lock.query("SELECT pg_advisory_unlock(22026)");
    const response = await delayed;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      defined: false,
      code: "CONFLICT",
      status: 409,
      message: "Conflict",
    });
    const rows = await secretRows(row.environmentId, "KEY");
    expect(rows.find((entry) => entry.id === row.id)).toEqual(removed);
    expect(rows.filter((entry) => entry.deletedAt === null)).toHaveLength(1);
    expect(await versionRows(row.id)).toEqual(versions);
    expect(await eventCount()).toBe(before + 1);
    expect(
      await db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.secretId, row.id),
            eq(auditEvent.action, "secret.rollback")
          )
        )
    ).toEqual([]);
  } finally {
    await lock.query("SELECT pg_advisory_unlock_all()");
    await delayed;
    await db.execute(sql`
      DROP TRIGGER IF EXISTS delay_secret_restore ON secret;
      DROP FUNCTION IF EXISTS delay_secret_restore();
    `);
    lock.release();
  }
});

test("safe update and rollback never return or log plaintext and store only encrypted values", async () => {
  const projectSlug = "safe-private";
  const { row } = await createVersionedSecret(projectSlug);
  const value = `PRIVATE_SAFE_${crypto.randomUUID()}`;
  const logs = spyConsole();
  try {
    const patch = await secretRequest("PATCH", projectSlug, "dev", "KEY", {
      value,
      expectedVersion: 2,
    });
    expect(patch.status).toBe(200);
    expect(await patch.text()).not.toContain(value);
    const rollback = await rollbackSecret(projectSlug, "KEY", 3);
    expect(rollback.status).toBe(200);
    expect(await rollback.text()).not.toContain(value);
    const versions = await versionRows(row.id);
    expect(versions[3]?.ciphertext).toEqual(versions[2]?.ciphertext);
    expect(versions[3]?.iv).toEqual(versions[2]?.iv);
    await Promise.all(
      [secret, secretVersion, projectKey, auditEvent].map(async (table) => {
        const result = await db.execute(
          sql`SELECT row_to_json(t)::text AS text FROM ${table} AS t`
        );
        assert.ok(!Array.isArray(result));
        for (const stored of result.rows) {
          expect(
            z.object({ text: z.string() }).parse(stored).text
          ).not.toContain(value);
        }
      })
    );
    const bytes = await db.execute(sql`
      SELECT position(convert_to(${value}, 'UTF8') in ciphertext) AS ciphertext,
        position(convert_to(${value}, 'UTF8') in iv) AS iv FROM secret_version
      UNION ALL
      SELECT position(convert_to(${value}, 'UTF8') in wrapped_dek),
        position(convert_to(${value}, 'UTF8') in iv) FROM project_key
    `);
    assert.ok(!Array.isArray(bytes));
    for (const stored of bytes.rows) {
      expect(stored).toEqual({ ciphertext: 0, iv: 0 });
    }
    for (const log of logs) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(value);
    }
  } finally {
    for (const log of logs) {
      log.mockRestore();
    }
  }
});

const secretMutationRoutes = [
  {
    method: "PATCH",
    suffix: "",
    field: "expectedVersion",
    body: { value: "PRIVATE_INVALID_VALUE", expectedVersion: 1 },
  },
  {
    method: "POST",
    suffix: "/rollback",
    field: "version",
    body: { version: 1 },
  },
];

test.each(
  secretMutationRoutes.flatMap((route) =>
    [0, -1, 1.5, "1", null, undefined, 2_147_483_648].map((version) => ({
      ...route,
      version,
    }))
  )
)(
  "$method rejects invalid $field $version without writes or input disclosure",
  async ({ method, suffix, field, body, version }) => {
    const before = await secretState();
    const response = await secretRouteRequest(
      method,
      "secret-vault",
      "dev",
      `/API_URL${suffix}`,
      { ...body, [field]: version }
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: "BAD_REQUEST" });
    expect(text).not.toContain("PRIVATE_INVALID_VALUE");
    expect(text).not.toContain('"input":');
    expect(text).not.toContain(`"${field}":`);
    expect(await secretState()).toEqual(before);
  }
);

test.each(
  secretMutationRoutes.flatMap((route) =>
    ["lower", "1ABC", "BAD-KEY"].map((key) => ({ ...route, key }))
  )
)(
  "$method rejects invalid secret key $key without writes",
  async ({ method, suffix, body, key }) => {
    const before = await secretState();
    const response = await secretRouteRequest(
      method,
      "secret-vault",
      "dev",
      `/${key}${suffix}`,
      body
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: "BAD_REQUEST" });
    expect(text).not.toContain(key);
    expect(text).not.toContain("PRIVATE_INVALID_VALUE");
    expect(await secretState()).toEqual(before);
  }
);

test.each([
  { name: "oversize", value: `PRIVATE_TOO_BIG_${"é".repeat(32_768)}` },
  { name: "lone surrogate", value: "PRIVATE_SURROGATE_\uD800" },
  { name: "number", value: 123 },
  { name: "missing", value: undefined },
])(
  "safe update rejects $name values without writes or logs",
  async ({ value }) => {
    const before = await secretState();
    const logs = spyConsole();
    try {
      const response = await secretRequest(
        "PATCH",
        "secret-vault",
        "dev",
        "API_URL",
        { value, expectedVersion: 1 }
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: "BAD_REQUEST" });
      expect(text).not.toContain("PRIVATE_");
      expect(await secretState()).toEqual(before);
      for (const log of logs) {
        expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_");
      }
    } finally {
      for (const log of logs) {
        log.mockRestore();
      }
    }
  }
);

test.each([false, true])(
  "safe update, rollback, set and remove serialize without gaps or server errors (removed: %s)",
  async (removed) => {
    const projectSlug = `safe-mixed-${removed}`;
    const { row } = await createVersionedSecret(projectSlug);
    if (removed) {
      const deletion = await secretRequest("DELETE", projectSlug, "dev", "KEY");
      expect(deletion.status).toBe(204);
    }
    const before = await eventCount();
    const responses = await Promise.all([
      secretRequest("PATCH", projectSlug, "dev", "KEY", {
        value: "safe",
        expectedVersion: 2,
      }),
      rollbackSecret(projectSlug, "KEY", 1),
      secretRequest("PUT", projectSlug, "dev", "KEY", { value: "set" }),
      secretRequest("DELETE", projectSlug, "dev", "KEY"),
    ]);
    for (const response of responses) {
      expect([200, 204, 404, 409]).toContain(response.status);
    }
    const rows = await secretRows(row.environmentId, "KEY");
    expect(
      rows.filter((entry) => entry.deletedAt === null).length
    ).toBeLessThanOrEqual(1);
    const histories = await Promise.all(
      rows.map(async (entry) => {
        const versions = await versionRows(entry.id);
        expect(versions.map((version) => version.version)).toEqual(
          versions.map((_, index) => index + 1)
        );
        expect(entry.currentVersionId).toBe(firstRow(versions.slice(-1)).id);
        return versions;
      })
    );
    expect(histories.flat()).toHaveLength(
      2 + responses.filter((response) => response.status === 200).length
    );
    expect(await eventCount()).toBe(
      before +
        responses.filter((response) => [200, 204].includes(response.status))
          .length
    );
  }
);

test("rollback selects the same removed history using removal, creation and id ordering", async () => {
  const projectSlug = "rollback-history-order";
  const { row } = await createVersionedSecret(projectSlug);
  const source = firstRow(await versionRows(row.id));
  const old = new Date("2025-01-01T00:00:00Z");
  const recent = new Date("2025-02-01T00:00:00Z");
  const candidates = [
    { id: "rollback-z", deletedAt: old, createdAt: recent },
    { id: "rollback-y", deletedAt: recent, createdAt: old },
    { id: "rollback-a", deletedAt: recent, createdAt: recent },
    { id: "rollback-b", deletedAt: recent, createdAt: recent },
  ];
  await db.insert(secret).values(
    candidates.map((candidate) => ({
      ...candidate,
      environmentId: row.environmentId,
      key: "HISTORY",
      kind: "token",
    }))
  );
  await db.insert(secretVersion).values(
    candidates.map((candidate, index) => ({
      secretId: candidate.id,
      version: index + 1,
      ciphertext: source.ciphertext,
      iv: source.iv,
      createdByType: "user",
      createdById: userA.id,
    }))
  );
  const before = await secretRows(row.environmentId, "HISTORY");
  const oldVersions = await Promise.all(
    candidates
      .slice(0, 3)
      .map(async (candidate) => await versionRows(candidate.id))
  );
  await expectSet(
    await rollbackSecret(projectSlug, "HISTORY", 4),
    "HISTORY",
    5,
    "token"
  );
  const after = await secretRows(row.environmentId, "HISTORY");
  expect(after.filter((candidate) => candidate.id !== "rollback-b")).toEqual(
    before.filter((candidate) => candidate.id !== "rollback-b")
  );
  expect(
    after.find((candidate) => candidate.id === "rollback-b")
  ).toMatchObject({ deletedAt: null });
  expect(
    await Promise.all(
      candidates
        .slice(0, 3)
        .map(async (candidate) => await versionRows(candidate.id))
    )
  ).toEqual(oldVersions);
  const history = await secretMetadataRequest(projectSlug, "dev", "HISTORY");
  expect(history.status).toBe(200);
  expect(await history.json()).toHaveLength(2);
  const get = await secretRequest("GET", projectSlug, "dev", "HISTORY");
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual({ key: "HISTORY", value: "A", version: 5 });
});

const exportRequest = async (
  projectSlug: string,
  env = "dev",
  query = "",
  cookie = userA.cookie
) =>
  await environmentRequest(
    "GET",
    projectSlug,
    `/${encodeURIComponent(env)}/export${query}`,
    undefined,
    cookie
  );
const exportFormats = ["json", "dotenv"] as const;

test("JSON exports only live current values of every kind in list order", async () => {
  await createSecretScope("export-current", ["dev", "prod"]);
  await Promise.all(
    [
      { key: "C", value: "three", kind: "env" },
      { key: "B", value: "two", kind: "token" },
      { key: "A", value: "one", kind: "secret" },
      { key: "GONE", value: "removed", kind: "secret" },
    ].map(
      async ({ key, ...body }) =>
        await expectSet(
          await secretRequest("PUT", "export-current", "dev", key, body),
          key,
          1,
          body.kind
        )
    )
  );
  await expectSet(
    await secretRequest("PUT", "export-current", "dev", "A", { value: "uno" }),
    "A",
    2
  );
  const deletion = await secretRequest(
    "DELETE",
    "export-current",
    "dev",
    "GONE"
  );
  expect(deletion.status).toBe(204);
  await expectSet(
    await secretRequest("PUT", "export-current", "prod", "A", {
      value: "other",
    }),
    "A",
    1
  );
  const responses = await Promise.all(
    ["", "?format=json"].map(
      async (query) => await exportRequest("export-current", "dev", query)
    )
  );
  const texts = await Promise.all(
    responses.map(async (response) => await response.text())
  );
  for (const [index, response] of responses.entries()) {
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(texts[index]).toBe('{"A":"uno","B":"two","C":"three"}');
  }
});

test("dotenv export round-trips spaces, quotes, comments, escapes and line breaks", async () => {
  await createSecretScope("export-dotenv");
  const entries = [
    "has space",
    "it's",
    'say "hi"',
    "tick`s",
    "a#b",
    "k=v",
    "$HOME",
    "back\\slash",
    "C:\\dir\\",
    "two\nlines",
    "a\r\nb",
    "a\rb",
    "",
    "\uFEFFbom",
  ].map((value, index) => ({ key: `KEY_${index}`, value }));
  await Promise.all(
    entries.map(
      async ({ key, value }) =>
        await expectSet(
          await secretRequest("PUT", "export-dotenv", "dev", key, { value }),
          key,
          1
        )
    )
  );
  const response = await exportRequest(
    "export-dotenv",
    "dev",
    "?format=dotenv"
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe(
    "text/plain; charset=utf-8"
  );
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(parse(await response.text())).toEqual(
    Object.fromEntries(entries.map(({ key, value }) => [key, value]))
  );
});

test.each(exportFormats)("empty environment exports as %s", async (format) => {
  const projectSlug = `export-empty-${format}`;
  await createSecretScope(projectSlug);
  const response = await exportRequest(projectSlug, "dev", `?format=${format}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.text()).toBe(format === "json" ? "{}" : "");
});

test.each(["a'b\"c`#", "\r\\n"])(
  "unwritable dotenv values fail with the first key only and still export as JSON",
  async (value) => {
    const projectSlug = `export-unwritable-${value.startsWith("a") ? "quotes" : "cr"}`;
    await createSecretScope(projectSlug);
    await Promise.all(
      ["C", "B"].map(
        async (key) =>
          await expectSet(
            await secretRequest("PUT", projectSlug, "dev", key, { value }),
            key,
            1
          )
      )
    );
    const before = await secretState();
    const logs = spyConsole();
    try {
      const response = await exportRequest(
        projectSlug,
        "dev",
        "?format=dotenv"
      );
      expect(response.status).toBe(422);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        defined: false,
        code: "UNPROCESSABLE_CONTENT",
        status: 422,
        message: "Secret B cannot be exported as dotenv; use format=json",
      });
      expect(text).not.toContain(value);
      expect(await secretState()).toEqual(before);
      const json = await exportRequest(projectSlug);
      expect(json.status).toBe(200);
      expect(await json.json()).toEqual({ B: value, C: value });
      for (const log of logs) {
        expect(JSON.stringify(log.mock.calls)).not.toContain(value);
      }
    } finally {
      for (const log of logs) {
        log.mockRestore();
      }
    }
  }
);

test.each([
  { projectSlug: "secret-vault", env: "dev", query: "?format=xml" },
  { projectSlug: "secret-vault", env: "dev", query: "?format=" },
  { projectSlug: "secret-vault", env: "dev", query: "?format=JSON" },
  { projectSlug: "Bad", env: "dev", query: "" },
  { projectSlug: "secret-vault", env: "Bad", query: "" },
])(
  "export rejects invalid input $projectSlug/$env$query without an audit event",
  async ({ projectSlug, env, query }) => {
    const before = await secretState();
    const response = await exportRequest(projectSlug, env, query);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ code: "BAD_REQUEST" });
    expect(await secretState()).toEqual(before);
  }
);

test.each(exportFormats)(
  "successful %s export records exactly one scoped audit event",
  async (format) => {
    const projectSlug = `export-audit-${format}`;
    const { projectRow, environments } = await createSecretScope(projectSlug);
    const value = "PRIVATE_EXPORT_AUDIT";
    await expectSet(
      await secretRequest("PUT", projectSlug, "dev", "KEY", { value }),
      "KEY",
      1
    );
    const before = await eventCount();
    const response = await exportRequest(
      projectSlug,
      "dev",
      `?format=${format}`
    );
    expect(response.status).toBe(200);
    expect(await eventCount()).toBe(before + 1);
    const events = await db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.projectId, projectRow.id),
          eq(auditEvent.action, "secret.export")
        )
      );
    expect(events).toHaveLength(1);
    expect(firstRow(events)).toMatchObject({
      action: "secret.export",
      actorType: "user",
      actorId: userA.id,
      projectId: projectRow.id,
      environmentId: firstRow(environments).id,
      secretId: null,
      ip: "192.0.2.1",
      userAgent: "Vault API test",
    });
    expect(JSON.stringify(events)).not.toContain(value);
  }
);

test.each(["ciphertext", "iv", "wrapped_dek"] as const)(
  "export checks all integrity before formatting and suppresses values on corrupt %s",
  async (column) => {
    const projectSlug = `export-tamper-${column.replaceAll("_", "-")}`;
    const { projectRow, environments } = await createSecretScope(projectSlug);
    const entries = [
      { key: "A", value: "a'b\"c`#" },
      { key: "B", value: "PRIVATE_EXPORT_TAMPER_B" },
      { key: "C", value: "PRIVATE_EXPORT_TAMPER_C" },
    ];
    const values = entries.map(({ value }) => value);
    await Promise.all(
      entries.map(
        async ({ key, value }) =>
          await expectSet(
            await secretRequest("PUT", projectSlug, "dev", key, { value }),
            key,
            1
          )
      )
    );
    if (column === "wrapped_dek") {
      await db.execute(
        sql`UPDATE project_key SET wrapped_dek = set_byte(wrapped_dek, 0, get_byte(wrapped_dek, 0) # 1) WHERE project_id = ${projectRow.id}`
      );
    } else {
      const row = firstRow(await secretRows(firstRow(environments).id, "B"));
      const field = secretVersion[column];
      await db.execute(
        sql`UPDATE secret_version SET ${sql.identifier(column)} = set_byte(${field}, 0, get_byte(${field}, 0) # 1) WHERE id = ${row.currentVersionId}`
      );
    }
    const before = await secretState();
    const logs = spyConsole();
    try {
      const responses = await Promise.all(
        exportFormats.map(
          async (format) =>
            await exportRequest(projectSlug, "dev", `?format=${format}`)
        )
      );
      const texts = await Promise.all(
        responses.map(async (response) => await response.text())
      );
      for (const [index, response] of responses.entries()) {
        expect(response.status).toBe(500);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        const text = texts[index] ?? "";
        expect(JSON.parse(text)).toEqual(integrityError);
        for (const value of values) {
          expect(text).not.toContain(value);
        }
      }
      expect(await secretState()).toEqual(before);
      for (const log of logs) {
        for (const value of values) {
          expect(JSON.stringify(log.mock.calls)).not.toContain(value);
        }
      }
    } finally {
      for (const log of logs) {
        log.mockRestore();
      }
    }
  }
);

test("rejected export audit inserts suppress both formats without values or writes", async () => {
  await createSecretScope("export-rejected-audit");
  const value = "PRIVATE_EXPORT_REJECTED_AUDIT";
  await expectSet(
    await secretRequest("PUT", "export-rejected-audit", "dev", "KEY", {
      value,
    }),
    "KEY",
    1
  );
  const before = await secretState();
  await db.execute(
    sql`ALTER TABLE audit_event ADD CONSTRAINT reject_all CHECK (false) NOT VALID`
  );
  const logs = spyConsole();
  try {
    const responses = await Promise.all(
      exportFormats.map(
        async (format) =>
          await exportRequest(
            "export-rejected-audit",
            "dev",
            `?format=${format}`
          )
      )
    );
    const texts = await Promise.all(
      responses.map(async (response) => await response.text())
    );
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(500);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const text = texts[index] ?? "";
      expect(JSON.parse(text)).toEqual(genericError);
      expect(text).not.toContain(value);
    }
    expect(await secretState()).toEqual(before);
    for (const log of logs) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(value);
    }
  } finally {
    for (const log of logs) {
      log.mockRestore();
    }
    await db.execute(sql`ALTER TABLE audit_event DROP CONSTRAINT reject_all`);
  }
});

test.each(exportFormats)(
  "%s export hides unowned projects and missing environments without audit",
  async (format) => {
    const before = await secretState();
    const query = `?format=${format}`;
    const unowned = await exportRequest(
      "secret-vault",
      "dev",
      query,
      userB.cookie
    );
    const absent = await exportRequest(
      "nobody-owns-this",
      "dev",
      query,
      userB.cookie
    );
    const missingEnv = await exportRequest("secret-vault", "missing", query);
    const expected = {
      defined: false,
      code: "NOT_FOUND",
      status: 404,
      message: "Not Found",
    };
    expect(unowned.status).toBe(404);
    expect(absent.status).toBe(404);
    const text = await unowned.text();
    expect(text).toBe(await absent.text());
    expect(JSON.parse(text)).toEqual(expected);
    expect(missingEnv.status).toBe(404);
    expect(await missingEnv.json()).toEqual(expected);
    for (const response of [unowned, absent, missingEnv]) {
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(await secretState()).toEqual(before);
  }
);

test.each(
  ["", unknownCookie].flatMap((cookie) =>
    [
      { projectSlug: "secret-vault", env: "dev", query: "" },
      { projectSlug: "Bad", env: "dev", query: "?format=json" },
      { projectSlug: "secret-vault", env: "Bad", query: "?format=dotenv" },
      { projectSlug: "secret-vault", env: "dev", query: "?format=xml" },
    ].map((scope) => ({ cookie, ...scope }))
  )
)(
  "anonymous export $projectSlug/$env$query rejects before validation or lookup",
  async ({ cookie, projectSlug, env, query }) => {
    const before = await secretState();
    const baseline = await handler(
      new Request(`${baseURL}/api/v1/private-data`)
    );
    const response = await exportRequest(projectSlug, env, query, cookie);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toBe(await baseline.text());
    expect(await secretState()).toEqual(before);
  }
);
