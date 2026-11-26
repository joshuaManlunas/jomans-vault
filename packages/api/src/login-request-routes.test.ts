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
import { createDb } from "@jomans-vault/db";
import { apikey } from "@jomans-vault/db/schema/auth";
import { auditEvent, loginRequest } from "@jomans-vault/db/schema/vault";
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
const databaseName = `jomans_vault_login_${crypto.randomUUID().replaceAll("-", "")}`;
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.pathname = `/${databaseName}`;
const admin = new Pool({ connectionString: databaseUrl });
const db = createDb({ DATABASE_URL: isolatedUrl.toString() });
const baseURL = "http://localhost:5190";
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
const scope = { projects: { "my-app": ["development"] } };
const listPath = "/projects/my-app/envs/development/secrets";
const summarySchema = z
  .object({
    id: z.string(),
    machineName: z.string(),
    requestedAt: z.string(),
    expiresAt: z.string(),
    project: z.string().nullable(),
    env: z.string().nullable(),
    status: z.enum(["pending", "approved", "denied", "expired"]),
  })
  .strict();
const openSchema = z
  .object({
    id: z.string(),
    pollingSecret: z.string(),
    pairingCode: z.string(),
    expiresAt: z.string(),
  })
  .strict();
type Opened = z.infer<typeof openSchema>;
interface TestUser {
  cookie: string;
  id: string;
}
let owner: TestUser;
let other: TestUser;
let created = false;
const request = async (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown
) =>
  await handler(
    new Request(`${baseURL}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
const expectStatus = async (pending: Promise<Response>, status: number) => {
  const response = await pending;
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  return response;
};
const json = async (pending: Promise<Response>): Promise<unknown> => {
  const response = await pending;
  return await response.json();
};
const signupUser = async (email: string): Promise<TestUser> => {
  const response = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseURL },
      body: JSON.stringify({
        email,
        password: crypto.randomUUID(),
        name: "Login Tester",
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
const open = async (
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Opened> => {
  const response = await expectStatus(
    request(
      "POST",
      "/login-requests",
      headers,
      body ?? { machineName: "  laptop  " }
    ),
    201
  );
  return openSchema.parse(await response.json());
};
const approve = async (
  opened: Pick<Opened, "id" | "pairingCode">,
  input: Record<string, unknown> = {}
) =>
  await request(
    "POST",
    `/login-requests/${opened.id}/approve`,
    { cookie: owner.cookie },
    { scope, pairingCode: opened.pairingCode, ...input }
  );
const poll = async (opened: Opened) =>
  await request(
    "POST",
    `/login-requests/${opened.id}/poll`,
    {},
    { pollingSecret: opened.pollingSecret }
  );
const read = async (id: string) => {
  const response = await expectStatus(
    request("GET", `/login-requests/${id}`, { cookie: owner.cookie }),
    200
  );
  return summarySchema.parse(await response.json());
};
const deny = async (id: string) =>
  await request("POST", `/login-requests/${id}/deny`, { cookie: owner.cookie });
const snapshot = async () => ({
  requests: await db.select().from(loginRequest).orderBy(loginRequest.id),
  keys: await db.select().from(apikey).orderBy(apikey.id),
  audit: await db.select().from(auditEvent).orderBy(auditEvent.id),
});
const expectError = async (
  pending: Promise<Response>,
  status: number,
  code: string
) => {
  const response = await expectStatus(pending, status);
  const body = z.record(z.string(), z.unknown()).parse(await response.json());
  expect(body).toMatchObject({ status, code });
  if (status !== 400) {
    expect(Object.keys(body).toSorted()).toEqual([
      "code",
      "defined",
      "message",
      "status",
    ]);
  }
  return body;
};
const collect = async (opened: Opened) => {
  const response = await expectStatus(poll(opened), 200);
  return z
    .object({ status: z.literal("approved"), key: z.string() })
    .strict()
    .parse(await response.json());
};
const age = async (id: string) =>
  await db
    .update(loginRequest)
    .set({ expiresAt: new Date(0) })
    .where(eq(loginRequest.id, id));
const listKeys = async () =>
  z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        scope: z.unknown(),
        permissions: z.array(z.string()),
        expiresAt: z.string().nullable(),
      })
    )
    .parse(await json(request("GET", "/api-keys", { cookie: owner.cookie })));
const storedRequest = async (id: string) => {
  const [row] = await db
    .select()
    .from(loginRequest)
    .where(eq(loginRequest.id, id));
  if (!row) {
    throw new Error("Expected stored request");
  }
  return row;
};

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL("../../db/src/migrations", import.meta.url)
    ),
  });
  owner = await signupUser("login-owner@example.com");
  other = await signupUser("login-other@example.com");
  await Promise.all(
    (
      [
        [owner, "my-app"],
        [owner, "excluded-app"],
        [other, "other-app"],
      ] as const
    ).map(async ([user, slug]) => {
      await expectStatus(
        request(
          "POST",
          "/projects",
          { cookie: user.cookie },
          { slug, name: "App" }
        ),
        201
      );
      await expectStatus(
        request(
          "POST",
          `/projects/${slug}/envs`,
          { cookie: user.cookie },
          { slug: "development" }
        ),
        201
      );
    })
  );
  await expectStatus(
    request(
      "PUT",
      `${listPath}/TOKEN`,
      { cookie: owner.cookie },
      { value: "test-secret-value" }
    ),
    200
  );
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

test("anonymous open trims the name, stores only the secret hash, and polls pending for five minutes", async () => {
  const now = Date.now();
  const opened = await open();
  expect(opened.id).toMatch(/^[\da-f-]{36}$/u);
  expect(opened.pollingSecret).toMatch(/^[\w-]{43}$/u);
  expect(Math.abs(Date.parse(opened.expiresAt) - now - 300_000)).toBeLessThan(
    3000
  );
  const row = await storedRequest(opened.id);
  expect(row.machineName).toBe("laptop");
  expect(opened.pairingCode).toMatch(
    /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/u
  );
  expect(row.pairingCodeHash).toBe(
    Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(opened.pairingCode.replaceAll("-", ""))
      )
    ).toString("hex")
  );
  expect(row.failedPairingAttempts).toBe(0);
  expect(row.pollingSecretHash).toBe(
    Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(opened.pollingSecret)
      )
    ).toString("hex")
  );
  expect(row.expiresAt.getTime()).toBe(row.createdAt.getTime() + 300_000);
  expect(await json(poll(opened))).toEqual({ status: "pending" });
  const summary = await read(opened.id);
  expect(summary).toEqual({
    id: opened.id,
    machineName: "laptop",
    requestedAt: row.createdAt.toISOString(),
    expiresAt: opened.expiresAt,
    project: null,
    env: null,
    status: "pending",
  });
  expect(JSON.stringify(summary)).not.toContain(opened.pollingSecret);
  await expectError(
    request("GET", "/login-requests/absent", { cookie: owner.cookie }),
    404,
    "NOT_FOUND"
  );
});

test("opening accepts all credential types, the boundary name and unchecked suggestions", async () => {
  const key = z
    .object({ id: z.string(), key: z.string() })
    .parse(
      await json(
        request(
          "POST",
          "/api-keys",
          { cookie: owner.cookie },
          { name: "Existing", scope }
        )
      )
    );
  const credentials: Record<string, string>[] = [
    { cookie: owner.cookie },
    { "x-api-key": key.key },
    { "x-api-key": "jv_invalid" },
  ];
  await Promise.all(
    credentials.map(async (headers) => {
      const opened = await open(
        { machineName: "x".repeat(32), project: "not-owned", env: "not-real" },
        headers
      );
      expect(await read(opened.id)).toMatchObject({
        machineName: "x".repeat(32),
        project: "not-owned",
        env: "not-real",
      });
    })
  );
  await expectStatus(
    request("POST", `/api-keys/${key.id}/revoke`, { cookie: owner.cookie }),
    200
  );
  await open(
    { machineName: "revoked" },
    { "x-api-key": key.key, cookie: owner.cookie }
  );
});

test.each([
  { machineName: "x".repeat(33) },
  { machineName: "  " },
  { machineName: "laptop", project: "Bad Slug" },
  { machineName: "laptop", project: "valid", env: "Bad Slug" },
  { machineName: "laptop", env: "development" },
  {},
])("invalid opening %j inserts no row", async (input) => {
  const before = await snapshot();
  await expectError(
    request("POST", "/login-requests", {}, input),
    400,
    "BAD_REQUEST"
  );
  expect(await snapshot()).toEqual(before);
});

test("approval defaults to read and inject; the collected key enforces scope and permissions", async () => {
  const opened = await open();
  const response = await expectStatus(approve(opened), 200);
  const summary = summarySchema.parse(await response.json());
  expect(summary.status).toBe("approved");
  const collected = await collect(opened);
  expect(JSON.stringify(summary)).not.toContain(collected.key);
  const listed = await listKeys();
  const row = await storedRequest(opened.id);
  expect(listed.find((key) => key.id === row.apiKeyId)).toMatchObject({
    name: "laptop",
    scope,
    permissions: ["read", "inject"],
    expiresAt: null,
  });
  await Promise.all(
    [listPath, "/projects/my-app/envs/development/export"].map(
      async (path) =>
        await expectStatus(
          request("GET", path, { "x-api-key": collected.key }),
          200
        )
    )
  );
  await Promise.all(
    [
      `${listPath}/TOKEN`,
      "/projects/excluded-app/envs/development/secrets",
    ].map(
      async (path) =>
        await expectError(
          request("GET", path, { "x-api-key": collected.key }),
          403,
          "FORBIDDEN"
        )
    )
  );
  await expectError(poll(opened), 409, "CONFLICT");
  await expectError(approve(opened), 409, "CONFLICT");
  expect(await read(opened.id)).toMatchObject({ status: "approved" });
  await age(opened.id);
  expect(await read(opened.id)).toMatchObject({ status: "approved" });
  await expectError(poll(opened), 409, "CONFLICT");
});

test.each([
  { permissions: [], expected: ["read", "inject"] },
  { permissions: ["reveal"], expected: ["reveal"] },
  { permissions: ["read", "read", "inject"], expected: ["read", "inject"] },
])("approval permission handling %j", async ({ permissions, expected }) => {
  const opened = await open();
  await expectStatus(
    approve(opened, {
      permissions,
      scope: { projects: { "my-app": ["development", "development"] } },
    }),
    200
  );
  await collect(opened);
  const row = await storedRequest(opened.id);
  const listed = await listKeys();
  expect(listed.find((key) => key.id === row.apiKeyId)).toMatchObject({
    permissions: expected,
    scope,
  });
});

const invalidApprovals = [
  { scope: { projects: { "other-app": ["development"] } } },
  { scope: { projects: { missing: ["development"] } } },
  { scope: { projects: { "my-app": ["missing"] } } },
  { scope: { projects: {} } },
  { scope: { projects: { "my-app": [] } } },
  { permissions: ["admin"] },
];
test.each(invalidApprovals)(
  "invalid approval %j matches key creation and changes nothing",
  async (input) => {
    const opened = await open();
    const before = await snapshot();
    const rejected = await expectError(
      approve(opened, input),
      400,
      "BAD_REQUEST"
    );
    const keyRejected = await expectError(
      request(
        "POST",
        "/api-keys",
        { cookie: owner.cookie },
        { name: "laptop", scope, ...input }
      ),
      400,
      "BAD_REQUEST"
    );
    expect(rejected).toEqual(keyRejected);
    expect(await snapshot()).toEqual(before);
    expect(await read(opened.id)).toMatchObject({ status: "pending" });
  }
);

test("approval checks existence and state before scope ownership", async () => {
  const unowned = { scope: { projects: { "other-app": ["development"] } } };
  await expectError(
    approve({ id: "absent", pairingCode: "wrong" }, unowned),
    404,
    "NOT_FOUND"
  );
  const opened = await open();
  await expectStatus(deny(opened.id), 200);
  await expectError(approve(opened, unowned), 409, "CONFLICT");
});

test("concurrent approvals create one key and event; concurrent polls hand out one key", async () => {
  const opened = await open();
  const before = await snapshot();
  const approvals = await Promise.all([approve(opened), approve(opened)]);
  expect(approvals.map((response) => response.status).toSorted()).toEqual([
    200, 409,
  ]);
  const after = await snapshot();
  expect(after.keys).toHaveLength(before.keys.length + 1);
  expect(after.audit).toHaveLength(before.audit.length + 1);
  const row = await storedRequest(opened.id);
  expect(
    after.audit.filter((event) => event.apiKeyId === row.apiKeyId)
  ).toEqual([
    expect.objectContaining({
      action: "apikey.create",
      actorType: "user",
      actorId: owner.id,
      apiKeyId: row.apiKeyId,
    }),
  ]);
  const polls = await Promise.all([poll(opened), poll(opened)]);
  expect(polls.map((response) => response.status).toSorted()).toEqual([
    200, 409,
  ]);
  const bodies = await Promise.all(
    polls.map(async (response) =>
      z.record(z.string(), z.unknown()).parse(await response.json())
    )
  );
  expect(bodies.filter((body) => typeof body.key === "string")).toHaveLength(1);
});

test("wrong polling secret and unknown id have identical private 404 bodies", async () => {
  const opened = await open();
  const bodies = await Promise.all(
    [
      { ...opened, pollingSecret: "wrong" },
      { ...opened, id: "unknown" },
    ].map(async (input) => await expectError(poll(input), 404, "NOT_FOUND"))
  );
  expect(bodies[0]).toEqual(bodies[1]);
  expect(JSON.stringify(bodies)).not.toContain(opened.id);
  expect(JSON.stringify(bodies)).not.toContain("laptop");
  await Promise.all(
    [
      undefined,
      {},
      { pollingSecret: "" },
      { pollingSecret: "x".repeat(257) },
    ].map(
      async (input) =>
        await expectError(
          request("POST", `/login-requests/${opened.id}/poll`, {}, input),
          400,
          "BAD_REQUEST"
        )
    )
  );
  await expectError(
    request(
      "POST",
      `/login-requests/${opened.id}/poll?pollingSecret=${opened.pollingSecret}`
    ),
    400,
    "BAD_REQUEST"
  );
});

test("denial is final, including after expiry", async () => {
  const opened = await open();
  const denied = await expectStatus(deny(opened.id), 200);
  expect(summarySchema.parse(await denied.json()).status).toBe("denied");
  const before = await snapshot();
  expect(await json(poll(opened))).toEqual({ status: "denied" });
  await expectError(approve(opened), 409, "CONFLICT");
  await expectError(deny(opened.id), 409, "CONFLICT");
  expect(await snapshot()).toEqual(before);
  await age(opened.id);
  expect(await read(opened.id)).toMatchObject({ status: "denied" });
  expect(await json(poll(opened))).toEqual({ status: "denied" });
  await expectError(deny("absent"), 404, "NOT_FOUND");
});

test("pending and approved requests expire, clear ciphertext and never decrypt an expired key", async () => {
  const pending = await open();
  await age(pending.id);
  const before = await snapshot();
  expect(await read(pending.id)).toMatchObject({ status: "expired" });
  await expectError(approve(pending), 409, "CONFLICT");
  await expectError(deny(pending.id), 409, "CONFLICT");
  expect(await snapshot()).toEqual(before);
  expect(await json(poll(pending))).toEqual({ status: "expired" });
  const approved = await open();
  await expectStatus(approve(approved), 200);
  await age(approved.id);
  expect(await read(approved.id)).toMatchObject({ status: "expired" });
  const decrypt = spyOn(crypto.subtle, "decrypt");
  try {
    expect(await json(poll(approved))).toEqual({ status: "expired" });
    expect(decrypt).not.toHaveBeenCalled();
  } finally {
    decrypt.mockRestore();
  }
  const row = await storedRequest(approved.id);
  expect(row).toMatchObject({
    keyCiphertext: null,
    keyIv: null,
    wrappedDek: null,
    dekIv: null,
  });
  expect(
    await db
      .select()
      .from(apikey)
      .where(eq(apikey.id, row.apiKeyId ?? ""))
  ).toHaveLength(1);
});

test("read, approve and deny require a user session and ignore API key cookie fallback", async () => {
  const opened = await open();
  const key = z
    .object({ key: z.string() })
    .parse(
      await json(
        request(
          "POST",
          "/api-keys",
          { cookie: owner.cookie },
          { name: "Auth test", scope }
        )
      )
    );
  setSystemTime(Date.now());
  try {
    await expectStatus(request("GET", listPath, { "x-api-key": key.key }), 200);
    const before = await snapshot();
    const credentials: Record<string, string>[] = [
      {},
      { "x-api-key": key.key },
      { "x-api-key": key.key, cookie: owner.cookie },
    ];
    const routes = [
      ["GET", "", undefined],
      ["POST", "/approve", { scope, pairingCode: opened.pairingCode }],
      ["POST", "/deny", undefined],
    ] as const;
    await Promise.all(
      credentials.flatMap((headers) =>
        routes.map(async ([method, suffix, body]) => {
          const apiKey = "x-api-key" in headers;
          await expectError(
            request(
              method,
              `/login-requests/${opened.id}${suffix}`,
              headers,
              body
            ),
            apiKey ? 403 : 401,
            apiKey ? "FORBIDDEN" : "UNAUTHORIZED"
          );
        })
      )
    );
    expect(await snapshot()).toEqual(before);
  } finally {
    setSystemTime();
  }
});

const failWrite = async (table: "audit_event" | "login_request") => {
  const condition =
    table === "audit_event"
      ? "NEW.action = 'apikey.create'"
      : "NEW.status = 'approved'";
  await db.execute(
    sql`CREATE FUNCTION reject_login_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${sql.raw(condition)} THEN RAISE EXCEPTION 'private failure detail'; END IF; RETURN NEW; END $$`
  );
  await db.execute(
    sql`CREATE TRIGGER reject_login_write BEFORE ${sql.raw(table === "audit_event" ? "INSERT" : "UPDATE")} ON ${sql.identifier(table)} FOR EACH ROW EXECUTE FUNCTION reject_login_write()`
  );
};
const restoreWrite = async (table: "audit_event" | "login_request") => {
  await db.execute(
    sql`DROP TRIGGER reject_login_write ON ${sql.identifier(table)}`
  );
  await db.execute(sql`DROP FUNCTION reject_login_write()`);
};
test.each(["audit_event", "login_request"] as const)(
  "%s failure rolls back the request and audit and compensates the external key",
  async (table) => {
    const opened = await open();
    const before = await snapshot();
    await failWrite(table);
    try {
      const body = await expectError(
        approve(opened),
        500,
        "INTERNAL_SERVER_ERROR"
      );
      expect(JSON.stringify(body)).not.toContain("private failure detail");
      expect(JSON.stringify(body)).not.toContain("jv_");
      expect(await snapshot()).toEqual(before);
      expect(await read(opened.id)).toMatchObject({ status: "pending" });
      expect(await json(poll(opened))).toEqual({ status: "pending" });
    } finally {
      await restoreWrite(table);
    }
  }
);

test("encryption failure removes the issued key and rolls back the audit", async () => {
  const opened = await open();
  const before = await snapshot();
  const encrypt = spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(
    new Error("private encryption failure")
  );
  try {
    const body = await expectError(
      approve(opened),
      500,
      "INTERNAL_SERVER_ERROR"
    );
    expect(JSON.stringify(body)).not.toContain("private encryption failure");
    expect(await snapshot()).toEqual(before);
  } finally {
    encrypt.mockRestore();
  }
});

test("stored rows contain neither secret nor key before and after collection", async () => {
  const opened = await open();
  await expectStatus(approve(opened), 200);
  const row = await storedRequest(opened.id);
  expect(row.keyCiphertext).not.toBeNull();
  expect(row.wrappedDek).not.toBeNull();
  const before = await db.execute<{ value: string }>(
    sql`SELECT row_to_json(t)::text AS value FROM login_request t UNION ALL SELECT row_to_json(t)::text FROM apikey t UNION ALL SELECT row_to_json(t)::text FROM audit_event t`
  );
  const { key } = await collect(opened);
  const after = await db.execute<{ value: string }>(
    sql`SELECT row_to_json(t)::text AS value FROM login_request t UNION ALL SELECT row_to_json(t)::text FROM apikey t UNION ALL SELECT row_to_json(t)::text FROM audit_event t`
  );
  for (const result of [before, after]) {
    const dump = JSON.stringify(result.rows);
    for (const secret of [
      key,
      opened.pollingSecret,
      opened.pairingCode,
      opened.pairingCode.replaceAll("-", ""),
    ]) {
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain(Buffer.from(secret).toString("hex"));
    }
  }
  expect(await storedRequest(opened.id)).toMatchObject({
    status: "collected",
    keyCiphertext: null,
    keyIv: null,
    wrappedDek: null,
    dekIv: null,
  });
});

test("PLAN documents routes, five minutes and one-time collection", async () => {
  const plan = await readFile(
    new URL("../../../PLAN.md", import.meta.url),
    "utf-8"
  );
  expect(plan).toContain("`POST /api/v1/login-requests`");
  expect(plan).toContain("expires after 5 minutes");
  expect(plan).toContain("collected once with the polling secret");
});

test.each(["typed", "lowercase", "spaces"])(
  "pairing code approves as %s",
  async (format) => {
    const opened = await open();
    let { pairingCode } = opened;
    if (format === "lowercase") {
      pairingCode = pairingCode.toLowerCase().replaceAll("-", "");
    } else if (format === "spaces") {
      pairingCode = ` \t${pairingCode.replaceAll("-", " \n")} `;
    }
    await expectStatus(approve(opened, { pairingCode }), 200);
    const { key } = await collect(opened);
    await expectStatus(request("GET", listPath, { "x-api-key": key }), 200);
  }
);

test("wrong pairing code commits only the counter and leaves the request pending", async () => {
  const opened = await open();
  const before = await snapshot();
  await expectError(
    approve(opened, { pairingCode: "wrong" }),
    403,
    "PAIRING_CODE_MISMATCH"
  );
  const after = await snapshot();
  expect(after).toEqual({
    ...before,
    requests: before.requests.map((row) =>
      row.id === opened.id ? { ...row, failedPairingAttempts: 1 } : row
    ),
  });
  expect(await read(opened.id)).toMatchObject({ status: "pending" });
});

test.each([undefined, " \t\n", 123])(
  "invalid pairing code %j changes nothing",
  async (pairingCode) => {
    const opened = await open();
    const before = await snapshot();
    await expectError(approve(opened, { pairingCode }), 400, "BAD_REQUEST");
    expect(await snapshot()).toEqual(before);
  }
);

test("fifth wrong code denies and prevents any later decision", async () => {
  const opened = await open();
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Verify each committed attempt and the final lockout.
    await expectError(
      approve(opened, { pairingCode: "wrong" }),
      attempt === 5 ? 409 : 403,
      attempt === 5 ? "CONFLICT" : "PAIRING_CODE_MISMATCH"
    );
  }
  expect(await storedRequest(opened.id)).toMatchObject({
    status: "denied",
    failedPairingAttempts: 5,
  });
  await expectError(approve(opened), 409, "CONFLICT");
  await expectError(deny(opened.id), 409, "CONFLICT");
  expect(await json(poll(opened))).toEqual({ status: "denied" });
});

test("legacy requests without a pairing hash cannot approve", async () => {
  const opened = await open();
  await db
    .update(loginRequest)
    .set({ pairingCodeHash: null })
    .where(eq(loginRequest.id, opened.id));
  const before = await snapshot();
  await expectError(approve(opened), 403, "PAIRING_CODE_MISMATCH");
  const after = await snapshot();
  expect(after.keys).toEqual(before.keys);
  expect(after.audit).toEqual(before.audit);
  expect(await storedRequest(opened.id)).toMatchObject({
    status: "pending",
    failedPairingAttempts: 1,
  });
});

test("concurrent wrong pairing codes count exactly and deny at five", async () => {
  const opened = await open();
  const before = await snapshot();
  const responses = await Promise.all(
    Array.from(
      { length: 5 },
      async () => await approve(opened, { pairingCode: "wrong" })
    )
  );
  expect(responses.map((response) => response.status).toSorted()).toEqual([
    403, 403, 403, 403, 409,
  ]);
  expect(await storedRequest(opened.id)).toMatchObject({
    status: "denied",
    failedPairingAttempts: 5,
  });
  const after = await snapshot();
  expect(after.keys).toEqual(before.keys);
  expect(after.audit).toEqual(before.audit);
});

test("read-only login approval cannot export values", async () => {
  const opened = await open();
  await expectStatus(approve(opened, { permissions: ["read"] }), 200);
  const { key } = await collect(opened);
  await expectError(
    request("GET", "/projects/my-app/envs/development/export", {
      "x-api-key": key,
    }),
    403,
    "FORBIDDEN"
  );
});
