import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createAuth } from "@jomans-vault/auth";
import { createDb } from "@jomans-vault/db";
import { apikey } from "@jomans-vault/db/schema/auth";
import { auditEvent, project } from "@jomans-vault/db/schema/vault";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as z from "zod";

import { createVaultApiHandler } from "./handler";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "API tests require DATABASE_URL to create an isolated test database"
  );
}
const databaseName = `jomans_vault_audit_routes_${crypto.randomUUID().replaceAll("-", "")}`;
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.pathname = `/${databaseName}`;
const admin = new Pool({ connectionString: databaseUrl });
const db = createDb({ DATABASE_URL: isolatedUrl.toString() });
const baseURL = "http://localhost:5160";
const auth = createAuth(
  {
    BETTER_AUTH_URL: baseURL,
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  },
  db
);
const handler = createVaultApiHandler({
  db,
  auth,
  masterKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64"
  ),
});
const plaintext = "audit-test-secret-never-returned";
const metadata = {
  "X-Forwarded-For": "192.0.2.16",
  "User-Agent": "Audit route test",
};
const eventSchema = z
  .object({
    id: z.string(),
    action: z.string(),
    actorType: z.string(),
    actorId: z.string(),
    projectId: z.string().nullable(),
    projectSlug: z.string().nullable(),
    environmentId: z.string().nullable(),
    environmentSlug: z.string().nullable(),
    secretId: z.string().nullable(),
    secretKey: z.string().nullable(),
    apiKeyId: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
const pageSchema = z
  .object({ events: z.array(eventSchema), nextCursor: z.string().nullable() })
  .strict();
const keySchema = z.object({ id: z.string(), key: z.string() });
type Event = z.infer<typeof eventSchema>;
interface TestUser {
  id: string;
  cookie: string;
}
interface Fixture {
  user: TestUser;
  slug: string;
  projectId: string;
  key: z.infer<typeof keySchema>;
  revokedKey: z.infer<typeof keySchema>;
}
let owner: Fixture;
let other: Fixture;
let created = false;

const request = async (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
) =>
  await handler(
    new Request(`${baseURL}/api/v1${path}`, {
      method,
      headers: { ...metadata, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
const signupUser = async (email: string): Promise<TestUser> => {
  const response = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseURL },
      body: JSON.stringify({
        email,
        password: crypto.randomUUID(),
        name: "Audit Tester",
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
const createKey = async (user: TestUser, slug: string) => {
  const response = await request(
    "POST",
    "/api-keys",
    { cookie: user.cookie },
    {
      name: "Audit reveal key",
      scope: { projects: { [slug]: ["development"] } },
      permissions: ["reveal"],
    }
  );
  expect(response.status).toBe(201);
  return keySchema.parse(await response.json());
};
const createProject = async (user: TestUser, slug: string) => {
  const projectResponse = await request(
    "POST",
    "/projects",
    { cookie: user.cookie },
    { slug, name: "Audit project" }
  );
  expect(projectResponse.status).toBe(201);
  const environmentResponse = await request(
    "POST",
    `/projects/${slug}/envs`,
    { cookie: user.cookie },
    { slug: "development" }
  );
  expect(environmentResponse.status).toBe(201);
  const secretResponse = await request(
    "PUT",
    `/projects/${slug}/envs/development/secrets/TOKEN`,
    { cookie: user.cookie },
    { value: plaintext }
  );
  expect(secretResponse.status).toBe(200);
  const [row] = await db
    .select({ id: project.id })
    .from(project)
    .where(eq(project.slug, slug));
  if (!row) {
    throw new Error("Missing test project");
  }
  return row.id;
};
const createFixture = async (slug: string): Promise<Fixture> => {
  const user = await signupUser(`${slug}@example.com`);
  const projectId = await createProject(user, slug);
  const key = await createKey(user, slug);
  const keyReveal = await request(
    "GET",
    `/projects/${slug}/envs/development/secrets/TOKEN`,
    {
      "x-api-key": key.key,
    }
  );
  expect(keyReveal.status).toBe(200);
  const userReveal = await request(
    "GET",
    `/projects/${slug}/envs/development/secrets/TOKEN`,
    {
      cookie: user.cookie,
    }
  );
  expect(userReveal.status).toBe(200);
  const revokedKey = await createKey(user, slug);
  const revokeResponse = await request(
    "POST",
    `/api-keys/${revokedKey.id}/revoke`,
    {
      cookie: user.cookie,
    }
  );
  expect(revokeResponse.status).toBe(200);
  return { user, slug, projectId, key, revokedKey };
};
const list = async (query = "", user = owner.user) => {
  const response = await request("GET", `/audit${query}`, {
    cookie: user.cookie,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  return pageSchema.parse(await response.json());
};
const expectError = async (
  response: Response,
  status: number,
  code: string
) => {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ status, code });
};
const compareEvents = (left: Event, right: Event) => {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt > right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id > right.id ? -1 : 1;
};

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../db/src/migrations", import.meta.url)
    ),
  });
  owner = await createFixture("audit-owner");
  other = await createFixture("audit-other");
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

test("own events include user and key actors, key lifecycle targets and descending order", async () => {
  const page = await list();
  expect(page.nextCursor).toBeNull();
  expect(page.events).toEqual(page.events.toSorted(compareEvents));
  for (const action of [
    "project.create",
    "environment.create",
    "secret.write",
  ]) {
    expect(page.events).toContainEqual(
      expect.objectContaining({
        action,
        actorType: "user",
        actorId: owner.user.id,
        projectId: owner.projectId,
      })
    );
  }
  expect(page.events).toContainEqual(
    expect.objectContaining({
      action: "secret.reveal",
      actorType: "apiKey",
      actorId: owner.key.id,
      projectId: owner.projectId,
      ip: metadata["X-Forwarded-For"],
      userAgent: metadata["User-Agent"],
    })
  );
  for (const action of ["apikey.create", "apikey.revoke"]) {
    expect(page.events).toContainEqual(
      expect.objectContaining({
        action,
        apiKeyId: owner.revokedKey.id,
        projectId: null,
      })
    );
  }
});

test("live names resolve and soft-deleted secret names remain", async () => {
  const page = await list();
  expect(page.events).toContainEqual(
    expect.objectContaining({
      action: "secret.write",
      projectSlug: owner.slug,
      environmentSlug: "development",
      secretKey: "TOKEN",
    })
  );
  const path = `/projects/${owner.slug}/envs/development/secrets/REMOVED`;
  const writeResponse = await request(
    "PUT",
    path,
    { cookie: owner.user.cookie },
    { value: plaintext }
  );
  expect(writeResponse.status).toBe(200);
  const deleteResponse = await request("DELETE", path, {
    cookie: owner.user.cookie,
  });
  expect(deleteResponse.status).toBe(204);
  const { events } = await list();
  expect(events).toContainEqual(
    expect.objectContaining({
      action: "secret.delete",
      projectSlug: owner.slug,
      environmentSlug: "development",
      secretKey: "REMOVED",
    })
  );
});

test("deleted project retains user and key history with missing names", async () => {
  const slug = "audit-deleted";
  const projectId = await createProject(owner.user, slug);
  const key = await createKey(owner.user, slug);
  const revealResponse = await request(
    "GET",
    `/projects/${slug}/envs/development/secrets/TOKEN`,
    {
      "x-api-key": key.key,
    }
  );
  expect(revealResponse.status).toBe(200);
  const { events: before } = await list(`?project=${slug}`);
  const deleteResponse = await request("DELETE", `/projects/${slug}`, {
    cookie: owner.user.cookie,
  });
  expect(deleteResponse.status).toBe(204);
  const { events } = await list();
  const retained = events.filter((event) => event.projectId === projectId);
  expect(retained.map((event) => event.id)).toEqual(
    expect.arrayContaining(before.map((event) => event.id))
  );
  expect(retained).toHaveLength(before.length + 1);
  expect(retained).toContainEqual(
    expect.objectContaining({ action: "project.delete", projectId })
  );
  expect(retained).toContainEqual(
    expect.objectContaining({
      action: "secret.reveal",
      actorType: "apiKey",
      actorId: key.id,
    })
  );
  for (const event of retained) {
    expect(event).toMatchObject({
      projectId,
      projectSlug: null,
      environmentSlug: null,
      secretKey: null,
    });
  }
  expect(await list(`?project=${slug}`)).toEqual({
    events: [],
    nextCursor: null,
  });
});

test("project and actor filters combine without exposing other users", async () => {
  const { events: allA } = await list();
  const { events: allB } = await list("", other.user);
  const otherIds = new Set(allB.map((event) => event.id));
  expect(allA.some((event) => otherIds.has(event.id))).toBe(false);
  const ownedIds = new Set(allA.map((event) => event.id));
  expect(allB.some((event) => ownedIds.has(event.id))).toBe(false);
  const cases = [
    {
      query: `?project=${owner.slug}`,
      expected: allA.filter((event) => event.projectId === owner.projectId),
    },
    {
      query: "?actor=user",
      expected: allA.filter(
        (event) => event.actorType === "user" && event.actorId === owner.user.id
      ),
    },
    {
      query: `?actor=${owner.key.id}`,
      expected: allA.filter(
        (event) =>
          event.actorType === "apiKey" && event.actorId === owner.key.id
      ),
    },
    {
      query: `?project=${owner.slug}&actor=${owner.key.id}`,
      expected: allA.filter(
        (event) =>
          event.projectId === owner.projectId &&
          event.actorType === "apiKey" &&
          event.actorId === owner.key.id
      ),
    },
  ];
  await Promise.all(
    cases.map(async ({ query, expected }) => {
      expect(expected.length).toBeGreaterThan(0);
      const { events } = await list(query);
      expect(events).toEqual(expected);
    })
  );
  await Promise.all(
    [
      `project=${other.slug}`,
      "project=no-such-project",
      `actor=${other.key.id}`,
      "actor=no-such-key",
      `project=${owner.slug}&actor=${other.key.id}`,
    ].map(async (query) => {
      const response = await request("GET", `/audit?${query}`, {
        cookie: owner.user.cookie,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"events":[],"nextCursor":null}');
    })
  );
});

test("actor filter retains deleted-key events visible through a live project", async () => {
  const user = await signupUser("audit-missing-key@example.com");
  const slug = "audit-missing-key";
  const projectId = await createProject(user, slug);
  const actorId = "deleted-key-id";
  const event = {
    id: "deleted-key-project-event",
    projectId,
    action: "secret.reveal",
    actorType: "apiKey",
    actorId,
  };
  await db
    .insert(auditEvent)
    .values([
      event,
      { ...event, id: "deleted-key-unowned-event", projectId: null },
      { ...event, id: "deleted-key-wrong-actor-event", actorType: "user" },
    ]);
  expect(
    await db
      .select({ id: apikey.id })
      .from(apikey)
      .where(eq(apikey.id, actorId))
  ).toEqual([]);
  const { events } = await list("", user);
  expect(events).toContainEqual(expect.objectContaining(event));
  const filtered = await list(`?actor=${actorId}`, user);
  expect(filtered).toEqual({
    events: [expect.objectContaining(event)],
    nextCursor: null,
  });
  expect(await list(`?project=${slug}&actor=${actorId}`, user)).toEqual(
    filtered
  );
  expect(await list(`?actor=${actorId}`, other.user)).toEqual({
    events: [],
    nextCursor: null,
  });
});

test("each SQL ownership alternative works independently and unknown stored strings remain readable", async () => {
  const rows = [
    {
      id: "owned-project-event",
      projectId: owner.projectId,
      actorType: "future-actor",
      actorId: "unknown",
    },
    {
      id: "owned-key-target-event",
      apiKeyId: owner.revokedKey.id,
      actorType: "future-actor",
      actorId: "unknown",
    },
    {
      id: "owned-key-actor-event",
      actorType: "apiKey",
      actorId: owner.revokedKey.id,
    },
    { id: "owned-user-actor-event", actorType: "user", actorId: owner.user.id },
    { id: "unowned-event", actorType: "future-actor", actorId: "unknown" },
    { id: "wrong-actor-type-event", actorType: "user", actorId: owner.key.id },
  ];
  await db
    .insert(auditEvent)
    .values(rows.map((row) => ({ ...row, action: "future.action" })));
  const { events } = await list();
  for (const row of rows.slice(0, 4)) {
    expect(events).toContainEqual(
      expect.objectContaining({ ...row, action: "future.action" })
    );
  }
  expect(
    events.some((event) =>
      ["unowned-event", "wrong-actor-type-event"].includes(event.id)
    )
  ).toBe(false);
  const { events: filtered } = await list(`?actor=${owner.revokedKey.id}`);
  expect(filtered).toContainEqual(
    expect.objectContaining({ id: "owned-key-actor-event" })
  );
  expect(filtered.some((event) => event.id === "owned-key-target-event")).toBe(
    false
  );
});

test("keyset pages preserve ties and microseconds when newer events arrive", async () => {
  const timestamps = [
    "123999",
    "123457",
    "123456",
    "123456",
    "123456",
    "123456",
    "123456",
    "123455",
    "123001",
  ];
  await db.insert(auditEvent).values(
    timestamps.map((fraction, index) => ({
      id: `paging-${index}`,
      action: "secret.reveal",
      actorType: "apiKey",
      actorId: owner.key.id,
      createdAt: sql`${`2100-01-01 12:00:00.${fraction}`}::timestamp`,
    }))
  );
  await db.insert(auditEvent).values({
    id: "paging-invisible",
    action: "secret.reveal",
    actorType: "apiKey",
    actorId: other.key.id,
    createdAt: sql`'2100-01-01 12:00:00.123456'::timestamp`,
  });
  const query = `?actor=${owner.key.id}`;
  const { events: expected } = await list(`${query}&limit=100`);
  expect(expected).toEqual(expected.toSorted(compareEvents));
  expect(expected.slice(0, 9).map((event) => event.id)).toEqual([
    "paging-0",
    "paging-1",
    "paging-6",
    "paging-5",
    "paging-4",
    "paging-3",
    "paging-2",
    "paging-7",
    "paging-8",
  ]);
  let page = await list(`${query}&limit=2`);
  const walked = [...page.events];
  expect(page.nextCursor).not.toBeNull();
  await db.insert(auditEvent).values({
    id: "paging-newer",
    action: "secret.reveal",
    actorType: "apiKey",
    actorId: owner.key.id,
    createdAt: sql`'2101-01-01'::timestamp`,
  });
  let pages = 1;
  while (page.nextCursor !== null && pages <= expected.length) {
    // oxlint-disable-next-line no-await-in-loop -- Each request needs the previous page's cursor.
    page = await list(
      `${query}&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`
    );
    expect(page.events.length).toBeLessThanOrEqual(2);
    walked.push(...page.events);
    pages += 1;
  }
  expect(page.nextCursor).toBeNull();
  expect(walked).toEqual(expected);
  expect(new Set(walked.map((event) => event.id)).size).toBe(expected.length);
});

test("default limit is 50 and maximum is 100", async () => {
  const user = await signupUser("audit-pagination-default@example.com");
  await db.insert(auditEvent).values(
    Array.from({ length: 55 }, (_, index) => ({
      id: `default-limit-${index}`,
      action: "project.create",
      actorType: "user",
      actorId: user.id,
    }))
  );
  const page = await list("", user);
  expect(page.events).toHaveLength(50);
  expect(page.nextCursor).not.toBeNull();
  const last = await list(`?cursor=${page.nextCursor}`, user);
  expect(last.events).toHaveLength(5);
  expect(last.nextCursor).toBeNull();
  const maximum = await list("?limit=100", user);
  expect(maximum.events).toHaveLength(55);
});

test.each([
  "cursor=not-a-cursor",
  "cursor=",
  "limit=0",
  "limit=101",
  "limit=abc",
  "limit=1.5",
  "project=Bad_Slug",
  "actor=",
  `actor=${"a".repeat(256)}`,
])("invalid query %s returns BAD_REQUEST", async (query) => {
  await expectError(
    await request("GET", `/audit?${query}`, { cookie: owner.user.cookie }),
    400,
    "BAD_REQUEST"
  );
});

test.each([
  {},
  { createdAt: "2100-02-30T00:00:00.123456Z", id: "id" },
  { createdAt: "2100-01-01T00:00:00.123Z", id: "id" },
  { createdAt: "2100-01-01T00:00:00.123456Z", id: "" },
  { createdAt: "0000-01-01T00:00:00.123456Z", id: "id" },
  { createdAt: "2100-01-01T00:00:00.123456Z", id: "invalid\0id" },
])("malformed cursor payload %j returns BAD_REQUEST", async (payload) => {
  const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url");
  await expectError(
    await request("GET", `/audit?cursor=${cursor}`, {
      cookie: owner.user.cookie,
    }),
    400,
    "BAD_REQUEST"
  );
});

test("API key credentials take precedence over cookies and anonymous access is rejected", async () => {
  const credentials: Record<string, string>[] = [
    { "x-api-key": owner.key.key },
    { "x-api-key": owner.key.key, cookie: owner.user.cookie },
  ];
  await Promise.all(
    credentials.map(async (headers) => {
      await expectError(
        await request("GET", "/audit", headers),
        403,
        "FORBIDDEN"
      );
    })
  );
  await expectError(await request("GET", "/audit", {}), 401, "UNAUTHORIZED");
});

test("strict output exposes no secret or key material and listing writes nothing", async () => {
  const [before] = await db
    .select({ count: sql<number>`count(*)::integer` })
    .from(auditEvent);
  const response = await request("GET", "/audit?limit=100", {
    cookie: owner.user.cookie,
  });
  expect(response.status).toBe(200);
  const raw = await response.text();
  expect(pageSchema.parse(JSON.parse(raw)).events.length).toBeGreaterThan(0);
  expect(raw).not.toContain(plaintext);
  const keys = await db.select({ key: apikey.key }).from(apikey);
  for (const material of [
    owner.key.key,
    owner.revokedKey.key,
    other.key.key,
    other.revokedKey.key,
    ...keys.map((key) => key.key),
  ]) {
    expect(raw).not.toContain(material);
  }
  const [after] = await db
    .select({ count: sql<number>`count(*)::integer` })
    .from(auditEvent);
  expect(after).toEqual(before);
});
