import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createAuth } from "@jomans-vault/auth";
import { createDb } from "@jomans-vault/db";
import {
  auditEvent,
  environment,
  project,
  secret,
  secretVersion,
} from "@jomans-vault/db/schema/vault";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as z from "zod";

import { createVaultApiHandler } from "./handler";
import { createVaultMcpHandler } from "./mcp";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "MCP tests require DATABASE_URL to create an isolated database"
  );
}
const databaseName = `jomans_vault_mcp_${crypto.randomUUID().replaceAll("-", "")}`;
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.pathname = `/${databaseName}`;
const admin = new Pool({ connectionString: databaseUrl });
const db = createDb({ DATABASE_URL: isolatedUrl.toString() });
const baseURL = "http://localhost:5270";
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
const rest = createVaultApiHandler({ db, auth, masterKey });
const handler = createVaultMcpHandler({ db, auth, masterKey });
const scope = { projects: { "my-app": ["development", "missing"] } };
let storedScope: typeof scope & {
  grants: Record<string, Record<string, string>>;
};
const target = { project: "my-app", environment: "development" };
const secretValue = "private-mcp-test-value";
const secondValue = "private-second-mcp-value";
const envPath = "/projects/my-app/envs/development";
const metadata = {
  "User-Agent": "Vault MCP test",
  "X-Forwarded-For": "192.0.2.10, 192.0.2.11",
};
const modernMeta = {
  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
  [CLIENT_INFO_META_KEY]: { name: "json-test", version: "1.0.0" },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};
type CreatedKey = Awaited<ReturnType<typeof auth.api.createApiKey>>;
interface TestUser {
  cookie: string;
  id: string;
}
let owner: TestUser;
let stranger: TestUser;
let keys: Record<
  "all" | "read" | "write" | "reveal" | "other" | "revoked",
  CreatedKey
>;
let created = false;

const signupUser = async (email: string): Promise<TestUser> => {
  const response = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseURL },
      body: JSON.stringify({
        email,
        password: crypto.randomUUID(),
        name: "MCP Tester",
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
const restRequest = async (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
) =>
  await rest(
    new Request(`${baseURL}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
const createKey = async (permissions: string[], userId = owner.id) =>
  await auth.api.createApiKey({
    body: {
      userId,
      metadata: storedScope,
      permissions: { secrets: permissions },
    },
  });

const withClient = async (
  key: string,
  run: (client: Client) => Promise<void>,
  keyHeader = "Authorization"
) => {
  const client = new Client({ name: "vault-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseURL}/api/mcp`),
    {
      requestInit: {
        headers: {
          ...metadata,
          [keyHeader]: keyHeader === "Authorization" ? `Bearer ${key}` : key,
        },
      },
      fetch: async (input, init) => {
        const response = await handler(new Request(input.toString(), init));
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(response.headers.has("Mcp-Session-Id")).toBe(false);
        expect(response.headers.get("Content-Type") ?? "").not.toContain(
          "text/event-stream"
        );
        return response;
      },
    }
  );
  try {
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({
      name: "jomans-vault",
      version: "1.0.0",
    });
    expect(Object.keys(client.getServerCapabilities() ?? {})).toEqual([
      "tools",
    ]);
    await run(client);
  } finally {
    await client.close();
  }
};
const expectNoValues = (data: unknown, values = [secretValue, secondValue]) => {
  const serialized = JSON.stringify(data);
  for (const value of values) {
    expect(serialized).not.toContain(value);
  }
};
const snapshot = async () => ({
  secrets: await db.select().from(secret).orderBy(secret.id),
  versions: await db.select().from(secretVersion).orderBy(secretVersion.id),
  audit: await db.select().from(auditEvent).orderBy(auditEvent.id),
});
const rawRequest = (
  headers: Record<string, string>,
  method = "POST",
  body = "not json"
) =>
  new Request(`${baseURL}/api/mcp`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "POST" ? body : undefined,
  });

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../db/src/migrations", import.meta.url)
    ),
  });
  owner = await signupUser("mcp-owner@example.com");
  stranger = await signupUser("mcp-stranger@example.com");
  await Promise.all(
    ["my-app", "other-app"].map(async (slug) => {
      const response = await restRequest(
        "POST",
        "/projects",
        { cookie: owner.cookie },
        { slug, name: slug }
      );
      expect(response.status).toBe(201);
      await Promise.all(
        ["development", "production"].map(async (env) => {
          const environmentResponse = await restRequest(
            "POST",
            `/projects/${slug}/envs`,
            { cookie: owner.cookie },
            { slug: env }
          );
          expect(environmentResponse.status).toBe(201);
        })
      );
    })
  );
  await Promise.all(
    [
      ["Z_TOKEN", "token"],
      ["A_ENV", "env"],
    ].map(async ([key, kind]) => {
      const response = await restRequest(
        "PUT",
        `${envPath}/secrets/${key}`,
        { cookie: owner.cookie },
        { value: secretValue, kind, description: "Keep this description" }
      );
      expect(response.status).toBe(200);
    })
  );
  const missing = await restRequest(
    "POST",
    "/projects/my-app/envs",
    { cookie: owner.cookie },
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
    .where(eq(project.ownerId, owner.id));
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
  const removed = await restRequest("DELETE", "/projects/my-app/envs/missing", {
    cookie: owner.cookie,
  });
  expect(removed.status).toBe(204);
  keys = {
    all: await createKey(["read", "reveal", "inject", "write", "delete"]),
    read: await createKey(["read"]),
    write: await createKey(["write"]),
    reveal: await createKey(["reveal"]),
    other: await createKey(["read", "write"], stranger.id),
    revoked: await createKey(["read", "write"]),
  };
  const revoke = await restRequest(
    "POST",
    `/api-keys/${keys.revoked.id}/revoke`,
    { cookie: owner.cookie }
  );
  expect(revoke.status).toBe(200);
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

test("all-permission clients discover exactly the two tools with value-free output schemas", async () => {
  await withClient(keys.all.key, async (client) => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "list_keys",
      "set_secret",
    ]);
    for (const tool of tools) {
      expect(JSON.stringify(tool.outputSchema)).not.toContain('"value"');
    }
  });
});

test("list_keys returns sorted metadata without values or audit writes, using x-api-key", async () => {
  const before = await snapshot();
  await withClient(
    keys.read.key,
    async (client) => {
      const result = await client.callTool({
        name: "list_keys",
        arguments: target,
      });
      const listed = await restRequest("GET", `${envPath}/secrets`, {
        Authorization: `Bearer ${keys.read.key}`,
      });
      const data = { keys: await listed.json() };
      expect(result.structuredContent).toEqual(data);
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify(data) },
      ]);
      expect(
        z
          .object({
            keys: z.array(
              z.object({
                key: z.string(),
                kind: z.enum(["secret", "env", "token"]),
                version: z.number(),
                updatedAt: z.iso.datetime(),
              })
            ),
          })
          .parse(result.structuredContent)
          .keys.map((key) => key.key)
      ).toEqual(["A_ENV", "Z_TOKEN"]);
      expectNoValues(result);
    },
    "x-api-key"
  );
  expect(await snapshot()).toEqual(before);
});

test("list_keys uses REST scope, ownership and permission errors", async () => {
  const cases = [
    {
      key: keys.read.key,
      args: { ...target, project: "other-app" },
      error: "Forbidden",
    },
    {
      key: keys.read.key,
      args: { ...target, environment: "production" },
      error: "Forbidden",
    },
    { key: keys.write.key, args: target, error: "Forbidden" },
    { key: keys.other.key, args: target, error: "Not found" },
    {
      key: keys.read.key,
      args: { ...target, environment: "missing" },
      error: "Not found",
    },
  ];
  const before = await snapshot();
  await Promise.all(
    cases.map(async (entry) => {
      await withClient(entry.key, async (client) => {
        const result = await client.callTool({
          name: "list_keys",
          arguments: entry.args,
        });
        expect(result).toEqual({
          isError: true,
          content: [{ type: "text", text: entry.error }],
        });
        expectNoValues(result);
      });
    })
  );
  expect(await snapshot()).toEqual(before);
});

test("set_secret creates consecutive versions and returns only key and version", async () => {
  await withClient(keys.write.key, async (client) => {
    const store = async (value: string, version: number) => {
      const result = await client.callTool({
        name: "set_secret",
        arguments: { ...target, key: "NEW_KEY", value },
      });
      const data = { key: "NEW_KEY", version };
      expect(result.structuredContent).toEqual(data);
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify(data) },
      ]);
      expectNoValues(result);
    };
    await store(secretValue, 1);
    await store(secondValue, 2);
  });
  const [stored] = await db
    .select()
    .from(secret)
    .where(eq(secret.key, "NEW_KEY"));
  expect(stored?.kind).toBe("secret");
  const versions = await db
    .select()
    .from(secretVersion)
    .where(eq(secretVersion.secretId, stored?.id ?? ""))
    .orderBy(secretVersion.version);
  expect(versions.map((version) => version.version)).toEqual([1, 2]);
  const response = await restRequest("GET", `${envPath}/secrets/NEW_KEY`, {
    Authorization: `Bearer ${keys.reveal.key}`,
  });
  expect(await response.json()).toEqual({
    key: "NEW_KEY",
    version: 2,
    value: secondValue,
  });
  expectNoValues(await db.select().from(auditEvent));
});

test("set_secret rejects missing write, out-of-scope and invalid values without writes", async () => {
  const cases = [
    {
      key: keys.read.key,
      args: target,
      value: secretValue,
      error: "Forbidden",
    },
    {
      key: keys.write.key,
      args: { ...target, project: "other-app" },
      value: secretValue,
      error: "Forbidden",
    },
    {
      key: keys.write.key,
      args: { ...target, environment: "production" },
      value: secretValue,
      error: "Forbidden",
    },
    {
      key: keys.write.key,
      args: target,
      value: "é".repeat(32_769),
      error: "Invalid input",
    },
    {
      key: keys.write.key,
      args: target,
      value: "\uD800",
      error: "Invalid input",
    },
  ];
  const before = await snapshot();
  await Promise.all(
    cases.map(async (entry) => {
      await withClient(entry.key, async (client) => {
        const result = await client.callTool({
          name: "set_secret",
          arguments: { ...entry.args, key: "REJECTED", value: entry.value },
        });
        expect(result).toEqual({
          isError: true,
          content: [{ type: "text", text: entry.error }],
        });
        expectNoValues(result, [entry.value]);
      });
    })
  );
  expect(await snapshot()).toEqual(before);
});

test("each set_secret call writes one value-free audit row with the request metadata", async () => {
  const before = await db.select().from(auditEvent);
  await withClient(keys.write.key, async (client) => {
    const store = async (value: string) => {
      const result = await client.callTool({
        name: "set_secret",
        arguments: { ...target, key: "AUDITED", value },
      });
      expect(result.isError).not.toBe(true);
      expectNoValues(result);
    };
    await store(secretValue);
    await store(secondValue);
  });
  const after = await db.select().from(auditEvent);
  const rows = after.filter(
    (row) => !before.some((prior) => prior.id === row.id)
  );
  expect(rows).toHaveLength(2);
  const [stored] = await db
    .select()
    .from(secret)
    .where(eq(secret.key, "AUDITED"));
  for (const row of rows) {
    expect(row).toMatchObject({
      action: "secret.write",
      actorType: "apiKey",
      actorId: keys.write.id,
      ip: "192.0.2.10",
      userAgent: metadata["User-Agent"],
      secretId: stored?.id,
      environmentId: stored?.environmentId,
    });
    expect(row.projectId).toBeString();
    expectNoValues(row);
  }
});

test("unauthenticated causes return identical 401 bodies before parsing MCP with no writes", async () => {
  const before = await snapshot();
  const headers: Record<string, string>[] = [
    {},
    { Authorization: "Bearer malformed" },
    { Authorization: `Bearer ${keys.revoked.key}` },
    { cookie: owner.cookie },
    { Authorization: `Bearer ${keys.read.key}`, "x-api-key": keys.write.key },
  ];
  await Promise.all(
    headers.map(async (entry) => {
      const response = await handler(rawRequest(entry));
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.has("WWW-Authenticate")).toBe(false);
      expect(await response.text()).toBe(
        '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}'
      );
    })
  );
  expect(await snapshot()).toEqual(before);
});

test("Origin is rejected before authentication or MCP parsing", async () => {
  const before = await snapshot();
  await Promise.all(
    [baseURL, "https://untrusted.example", ""].map(async (origin) => {
      const response = await handler(
        rawRequest({ Authorization: `Bearer ${keys.all.key}`, Origin: origin })
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32_600, message: "Forbidden" },
        id: null,
      });
    })
  );
  expect(await snapshot()).toEqual(before);
});

test("2025 initialize is stateless JSON and unsupported methods return 405", async () => {
  const headers = {
    Authorization: `Bearer ${keys.all.key}`,
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-11-25",
  };
  const response = await handler(
    rawRequest(
      headers,
      "POST",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      })
    )
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.has("Mcp-Session-Id")).toBe(false);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({
    result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "jomans-vault", version: "1.0.0" },
    },
  });
  await Promise.all(
    ["GET", "DELETE"].map(async (method) => {
      const unsupported = await handler(rawRequest(headers, method));
      expect(unsupported.status).toBe(405);
      expect(unsupported.headers.get("Cache-Control")).toBe(
        "private, no-store"
      );
    })
  );
});

test("legacy clients list and set through the same tools with JSON-only responses", async () => {
  const headers = {
    Authorization: `Bearer ${keys.all.key}`,
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-11-25",
  };
  const list = await handler(
    rawRequest(
      headers,
      "POST",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    )
  );
  expect(list.headers.get("Content-Type")).toContain("application/json");
  expect(list.headers.has("Mcp-Session-Id")).toBe(false);
  const listed = z
    .object({
      result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
    })
    .parse(await list.json());
  expect(listed.result.tools.map((tool) => tool.name).toSorted()).toEqual([
    "list_keys",
    "set_secret",
  ]);
  const response = await handler(
    rawRequest(
      headers,
      "POST",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "set_secret",
          arguments: { ...target, key: "LEGACY_KEY", value: secretValue },
        },
      })
    )
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.has("Mcp-Session-Id")).toBe(false);
  const body = await response.json();
  expect(body).toMatchObject({
    id: 3,
    result: { structuredContent: { key: "LEGACY_KEY", version: 1 } },
  });
  expectNoValues(body);
  const revealed = await restRequest("GET", `${envPath}/secrets/LEGACY_KEY`, {
    Authorization: `Bearer ${keys.reveal.key}`,
  });
  expect(revealed.status).toBe(200);
  expect(await revealed.json()).toMatchObject({ value: secretValue });
});

test("modern requests return JSON and both eras reject subscription streams", async () => {
  const before = await snapshot();
  const warning = spyOn(console, "warn");
  try {
    await Promise.all(
      [false, true].map(async (modern) => {
        const headers = {
          Authorization: `Bearer ${keys.all.key}`,
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": modern ? "2026-07-28" : "2025-11-25",
        };
        await Promise.all(
          ["tools/list", "subscriptions/listen"].map(async (method) => {
            const response = await handler(
              rawRequest(
                { ...headers, ...(modern ? { "Mcp-Method": method } : {}) },
                "POST",
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: method,
                  method,
                  params: {
                    ...(modern ? { _meta: modernMeta } : {}),
                    ...(method === "subscriptions/listen"
                      ? { notifications: { toolsListChanged: true } }
                      : {}),
                  },
                })
              )
            );
            const body = await response.json();
            expect({ status: response.status, body }).toMatchObject({
              status: 200,
            });
            expect(response.headers.get("Content-Type")).toContain(
              "application/json"
            );
            expect(response.headers.has("Mcp-Session-Id")).toBe(false);
            expect(response.headers.get("Cache-Control")).toBe(
              "private, no-store"
            );
            if (method === "subscriptions/listen") {
              expect(body).toMatchObject({
                jsonrpc: "2.0",
                id: method,
                error: { code: modern ? -32_603 : -32_601 },
              });
            } else {
              expect(body).toMatchObject({
                id: method,
                result: {
                  tools: [{ name: "list_keys" }, { name: "set_secret" }],
                },
              });
            }
            expectNoValues(body);
          })
        );
      })
    );
    expect(await snapshot()).toEqual(before);
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

test("concurrent modern calls keep request permissions and audit context isolated", async () => {
  const before = await db.select().from(auditEvent);
  const cases = [
    { key: keys.write, name: "MODERN_WRITE", ip: "192.0.2.20" },
    { key: keys.all, name: "MODERN_ALL", ip: "192.0.2.21" },
    {
      key: keys.read,
      name: "MODERN_READ",
      ip: "192.0.2.22",
      error: "Forbidden",
    },
    {
      key: keys.other,
      name: "MODERN_OTHER",
      ip: "192.0.2.23",
      error: "Not found",
    },
  ];
  const warning = spyOn(console, "warn");
  try {
    await Promise.all(
      cases.map(async (entry) => {
        const response = await handler(
          rawRequest(
            {
              Authorization: `Bearer ${entry.key.key}`,
              Accept: "application/json, text/event-stream",
              "MCP-Protocol-Version": "2026-07-28",
              "Mcp-Method": "tools/call",
              "Mcp-Name": "set_secret",
              "User-Agent": entry.name,
              "X-Forwarded-For": entry.ip,
            },
            "POST",
            JSON.stringify({
              jsonrpc: "2.0",
              id: entry.name,
              method: "tools/call",
              params: {
                _meta: modernMeta,
                name: "set_secret",
                arguments: { ...target, key: entry.name, value: secretValue },
              },
            })
          )
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toContain(
          "application/json"
        );
        expect(response.headers.has("Mcp-Session-Id")).toBe(false);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        const result = entry.error
          ? { isError: true, content: [{ type: "text", text: entry.error }] }
          : {
              structuredContent: { key: entry.name, version: 1 },
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ key: entry.name, version: 1 }),
                },
              ],
            };
        const body = await response.json();
        expect(body).toMatchObject({ id: entry.name, result });
        expectNoValues(body);
      })
    );
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
  const after = await db.select().from(auditEvent);
  const rows = after.filter(
    (row) => !before.some((prior) => prior.id === row.id)
  );
  expect(rows).toHaveLength(2);
  const secrets = await db.select().from(secret);
  for (const entry of cases) {
    const stored = secrets.filter((row) => row.key === entry.name);
    if (entry.error) {
      expect(stored).toHaveLength(0);
    } else {
      expect(stored).toHaveLength(1);
      const events = rows.filter((row) => row.secretId === stored[0]?.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "secret.write",
        actorType: "apiKey",
        actorId: entry.key.id,
        ip: entry.ip,
        userAgent: entry.name,
        environmentId: stored[0]?.environmentId,
      });
      expect(events[0]?.projectId).toBeString();
    }
  }
  expectNoValues(rows);
});

test("MCP docs describe tools, permissions, boundaries and copyable client config", async () => {
  const docs = await Bun.file(
    new URL("../../../apps/fumadocs/content/docs/mcp.mdx", import.meta.url)
  ).text();
  for (const text of [
    "/api/mcp",
    "Authorization: Bearer",
    "x-api-key",
    "list_keys",
    "set_secret",
    "`read`",
    "`write`",
    "no tool to read a value or run a command",
    "claude mcp add --transport http",
  ]) {
    expect(docs).toContain(text);
  }
  const block = docs.split("```json\n")[1]?.split("```")[0] ?? "";
  expect(JSON.parse(block)).toMatchObject({
    mcpServers: {
      "jomans-vault": {
        type: "http",
        url: "https://vault.example.com/api/mcp",
        headers: { Authorization: "Bearer <key>" },
      },
    },
  });
});

test("the web route mounts createVaultMcpHandler for POST, GET and DELETE", async () => {
  const route = await Bun.file(
    new URL("../../../apps/web/src/routes/api/mcp.ts", import.meta.url)
  ).text();
  expect(route).toContain('createFileRoute("/api/mcp")');
  expect(route).toContain("createVaultMcpHandler({");
  for (const method of ["POST", "GET", "DELETE"]) {
    expect(route).toContain(`${method}: handle`);
  }
  const response = await handler(rawRequest({}));
  expect(response.status).toBe(401);
});

test("set_secret preserves kind and description and ignores unsupported fields", async () => {
  await withClient(keys.write.key, async (client) => {
    const result = await client.callTool({
      name: "set_secret",
      arguments: {
        ...target,
        key: "A_ENV",
        value: secondValue,
        kind: "secret",
        description: "Replace this",
      },
    });
    expect(result.structuredContent).toEqual({ key: "A_ENV", version: 2 });
    expectNoValues(result);
  });
  const [stored] = await db
    .select()
    .from(secret)
    .where(eq(secret.key, "A_ENV"));
  expect(stored).toMatchObject({
    kind: "env",
    description: "Keep this description",
  });
});

test("unexpected procedure failures produce a fixed error without values or logging", async () => {
  const before = await snapshot();
  await withClient(keys.write.key, async (client) => {
    const transaction = spyOn(db, "transaction").mockRejectedValueOnce(
      new Error(secretValue)
    );
    const errorLog = spyOn(console, "error");
    try {
      const result = await client.callTool({
        name: "set_secret",
        arguments: { ...target, key: "FAILED", value: secretValue },
      });
      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: "Internal error" }],
      });
      expectNoValues(result);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
      errorLog.mockRestore();
    }
  });
  expect(await snapshot()).toEqual(before);
});

test("invalid tool schemas fail safely and master keys are validated at creation", async () => {
  const before = await snapshot();
  await withClient(keys.write.key, async (client) => {
    await Promise.all(
      [
        { ...target, key: "lowercase", value: secretValue },
        { ...target, project: "INVALID", key: "VALID", value: secretValue },
      ].map(async (args) => {
        const result = await client.callTool({
          name: "set_secret",
          arguments: args,
        });
        expect(result.isError).toBe(true);
        expectNoValues(result);
      })
    );
  });
  expect(await snapshot()).toEqual(before);
  expect(() => createVaultMcpHandler({ db, auth, masterKey: "bad" })).toThrow();
});

test("set_secret refuses reserved names with the policy message and no writes", async () => {
  const before = await snapshot();
  await withClient(keys.write.key, async (client) => {
    const result = await client.callTool({
      name: "set_secret",
      arguments: { ...target, key: "NODE_OPTIONS", value: "refused" },
    });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "NODE_OPTIONS is reserved because it controls how programs start. Use a different name.",
        },
      ],
    });
  });
  expect(await snapshot()).toEqual(before);
});
