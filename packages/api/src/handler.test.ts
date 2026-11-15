import { afterAll, beforeAll, expect, test } from "bun:test";
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
} from "@jomans-vault/db/schema/vault";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { and, eq, sql } from "drizzle-orm";
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

test("the generated OpenAPI spec includes both REST operations", async () => {
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
    expect(Object.keys(event).toSorted()).toEqual([
      "action",
      "actorId",
      "actorType",
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
