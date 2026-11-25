import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import pathModule from "node:path";

import { auditEvent } from "@jomans-vault/db/schema/vault";
import { eq } from "drizzle-orm";
import * as z from "zod";

import { configDir } from "./config";
import { createCredentialStore } from "./credentials";
import {
  closedUrl,
  createSandbox,
  expectJvResult,
  runJv,
  startVault,
} from "./test/harness";
import type { JvResult, Sandbox, Vault } from "./test/harness";

let vault: Vault;
let cookie: string;
const sandboxes: Sandbox[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const sandbox = async () => {
  const box = await createSandbox();
  sandboxes.push(box);
  return box;
};
const stored = async (box: Sandbox, url: string, key: string) => {
  await Bun.write(
    pathModule.join(box.env.JV_TEST_KEYCHAIN ?? "", "keychain.json"),
    JSON.stringify({ jv: { [url]: key, "https://other.example": "keep" } })
  );
};
const result = (output: JvResult, exitCode: number, key?: string) => {
  expectJvResult(output, exitCode);
  if (key) {
    expect(output.stderr + output.stdout).not.toContain(key);
  }
};
const createKey = async () => {
  const response = await vault.api("POST", "/api-keys", {
    cookie,
    body: {
      name: "Logout test",
      scope: { projects: { "my-app": ["development"] } },
    },
  });
  expect(response.status).toBe(201);
  return z
    .object({ id: z.string(), key: z.string() })
    .parse(await response.json());
};
const expectRevoked = async (key: { id: string; key: string }) => {
  const response = await vault.api(
    "GET",
    "/projects/my-app/envs/development/secrets",
    {
      apiKey: key.key,
    }
  );
  expect(response.status).toBe(401);
  const listed = await vault.api("GET", "/api-keys", { cookie });
  expect(listed.status).toBe(200);
  const keys = z
    .array(z.object({ id: z.string(), revoked: z.boolean() }))
    .parse(await listed.json());
  expect(keys.find((row) => row.id === key.id)?.revoked).toBe(true);
};
const stub = (status: number) => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return new Response(null, { status });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests: () => requests };
};
const expectRemoved = async (box: Sandbox, url: string) => {
  const entries = await box.keychain();
  expect(entries.jv?.[url]).toBeUndefined();
  expect(entries.jv?.["https://other.example"]).toBe("keep");
};

beforeAll(async () => {
  vault = await startVault();
  ({ cookie } = await vault.signup("cli-logout@example.com"));
  const projectResponse = await vault.api("POST", "/projects", {
    cookie,
    body: { slug: "my-app", name: "My app" },
  });
  expect(projectResponse.status).toBe(201);
  const environmentResponse = await vault.api("POST", "/projects/my-app/envs", {
    cookie,
    body: { slug: "development" },
  });
  expect(environmentResponse.status).toBe(201);
}, 30_000);
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await Promise.all(sandboxes.splice(0).map((box) => box.remove()));
});
afterAll(async () => {
  await vault?.stop();
});

test("logout revokes the keychain key, audits its actor, and clears both local stores", async () => {
  const box = await sandbox();
  const key = await createKey();
  await stored(box, vault.url, key.key);
  await mkdir(configDir(box.env), { recursive: true });
  const fallback = pathModule.join(configDir(box.env), "credentials.json");
  await Bun.write(
    fallback,
    JSON.stringify({
      [vault.url]: "stale",
      "https://other.example": "fallback-keep",
    })
  );
  const output = await runJv(["logout", "--url", `${vault.url}/`], {
    env: box.env,
  });
  result(output, 0, key.key);
  expect(output.stderr).toContain(
    `Logged out of ${vault.url}. The key was revoked and removed from this machine.`
  );
  await expectRemoved(box, vault.url);
  expect(await Bun.file(fallback).json()).toEqual({
    "https://other.example": "fallback-keep",
  });
  await expectRevoked(key);
  const events = await vault.db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.apiKeyId, key.id));
  expect(events.filter((event) => event.action === "apikey.revoke")).toEqual([
    expect.objectContaining({ actorType: "apiKey", actorId: key.id }),
  ]);
});

test("logout uses the remembered URL and preserves other fallback credentials and config bytes", async () => {
  const box = await sandbox();
  box.env.JV_TEST_KEYCHAIN = "unavailable";
  const key = await createKey();
  await mkdir(configDir(box.env), { recursive: true });
  const fallback = pathModule.join(configDir(box.env), "credentials.json");
  const config = pathModule.join(configDir(box.env), "config.json");
  const remembered = `${JSON.stringify({ url: `${vault.url}/` }, null, 2)}\n`;
  await Bun.write(
    fallback,
    JSON.stringify({ [vault.url]: key.key, "https://other.example": "keep" })
  );
  await Bun.write(config, remembered);
  const output = await runJv(["logout"], { env: box.env });
  result(output, 0, key.key);
  expect(output.stderr).toContain(
    `Logged out of ${vault.url}. The key was revoked and removed from this machine.`
  );
  expect(await Bun.file(fallback).json()).toEqual({
    "https://other.example": "keep",
  });
  expect(await readFile(config, "utf-8")).toBe(remembered);
  await expectRevoked(key);
});

test("logout finds fallback credentials after the keychain recovers", async () => {
  const box = await sandbox();
  const key = await createKey();
  const credentials = createCredentialStore({
    ...box.env,
    JV_TEST_KEYCHAIN: "unavailable",
  });
  const fallback = pathModule.join(configDir(box.env), "credentials.json");
  expect(await credentials.set(vault.url, key.key)).toEqual({
    kind: "file",
    path: fallback,
  });
  await credentials.set("https://other.example", "keep");
  expect(await box.keychain()).toEqual({});
  const output = await runJv(["logout", "--url", vault.url], { env: box.env });
  result(output, 0, key.key);
  expect(output.stderr).toContain(
    `Logged out of ${vault.url}. The key was revoked and removed from this machine.`
  );
  expect(await Bun.file(fallback).json()).toEqual({
    "https://other.example": "keep",
  });
  expect(await box.keychain()).toEqual({});
  await expectRevoked(key);
});

test("an already revoked key is removed successfully", async () => {
  const box = await sandbox();
  const key = await createKey();
  const revoked = await vault.api("POST", `/api-keys/${key.id}/revoke`, {
    cookie,
  });
  expect(revoked.status).toBe(200);
  await stored(box, vault.url, key.key);
  const output = await runJv(["logout", "--url", vault.url], { env: box.env });
  result(output, 0, key.key);
  expect(output.stderr).toContain(
    `Logged out of ${vault.url}. The key was already invalid and was removed from this machine.`
  );
  await expectRemoved(box, vault.url);
});

test("an unreachable vault warns but still removes the local key", async () => {
  const box = await sandbox();
  const url = await closedUrl();
  const key = "jv_unreachable_never_print";
  await stored(box, url, key);
  const output = await runJv(["logout", "--url", url], { env: box.env });
  result(output, 1, key);
  expect(output.stderr).toContain(
    `warning: could not reach the vault at ${url}. The key was removed from this machine but was NOT revoked. Revoke it on the API keys settings page.`
  );
  await expectRemoved(box, url);
});

test.each([302, 403, 404, 500])(
  "unexpected status %s warns but removes the local key",
  async (status) => {
    const box = await sandbox();
    const server = stub(status);
    const key = "jv_unexpected_never_print";
    await stored(box, server.url, key);
    const output = await runJv(["logout"], {
      env: { ...box.env, JV_URL: `${server.url}/` },
    });
    result(output, 1, key);
    expect(output.stderr).toContain(
      `warning: the vault at ${server.url} returned an unexpected response (${status}). The key was removed from this machine but was NOT revoked. Revoke it on the API keys settings page.`
    );
    expect(server.requests()).toBe(1);
    await expectRemoved(box, server.url);
  }
);

test("nothing stored and no configured URL succeed without any request or files", async () => {
  const box = await sandbox();
  const server = stub(500);
  const output = await runJv(["logout", "--url", server.url], { env: box.env });
  result(output, 0);
  expect(output.stderr).toContain(
    `Not logged in to ${server.url}. Nothing to log out of.`
  );
  expect(server.requests()).toBe(0);
  const unconfigured = await runJv(["logout"], { env: box.env });
  result(unconfigured, 0);
  expect(unconfigured.stderr).toContain(
    "Not logged in. Nothing to log out of."
  );
  expect(await box.keychain()).toEqual({});
  expect(
    await Bun.file(pathModule.join(configDir(box.env), "config.json")).exists()
  ).toBe(false);
  expect(
    await Bun.file(
      pathModule.join(configDir(box.env), "credentials.json")
    ).exists()
  ).toBe(false);
});

test.each([
  { args: ["--help"] },
  { args: ["help"] },
  { args: ["logout", "--help"] },
])("help %j lists logout", async ({ args }) => {
  const box = await sandbox();
  const commandArgs: string[] = [...args];
  const output = await runJv(commandArgs, { env: box.env });
  expect(output.exitCode).toBe(0);
  expect(output.stdout).toContain("jv logout [--url <url>]");
  expect(output.stdout).toContain(
    "logout   Log this machine out: revoke its key and remove it"
  );
});

test.each([
  { args: ["logout", "--no-browser"] },
  { args: ["logout", "extra"] },
  { args: ["logout", "--no-browser", "--help"] },
  { args: ["logout", "extra", "--help"] },
  { args: ["logout", "--url", "invalid"] },
])("usage error %j", async ({ args }) => {
  const box = await sandbox();
  const commandArgs: string[] = [...args];
  const output = await runJv(commandArgs, { env: box.env });
  result(output, 2);
  expect(output.stderr).toContain(
    commandArgs.includes("invalid") ? "Invalid vault URL" : "Usage:"
  );
});

test.each([200, 500])(
  "local deletion failure reports the revoke outcome for status %s",
  async (status) => {
    const box = await sandbox();
    const server = stub(status);
    const key = "jv_deletion_failure_never_print";
    await stored(box, server.url, key);
    await mkdir(pathModule.join(configDir(box.env), "credentials.json"), {
      recursive: true,
    });
    const output = await runJv(["logout", "--url", server.url], {
      env: box.env,
    });
    result(output, 1, key);
    expect(output.stderr).toContain(
      status === 200 ? "The key was revoked." : "The key was NOT revoked."
    );
    expect(output.stderr).toContain(
      "Could not remove the key from this machine:"
    );
    expect(output.stderr).toContain("EISDIR");
    expect(output.stderr).not.toContain("Logged out of");
  }
);

test("logout reports redirects without forwarding the key", async () => {
  const box = await sandbox();
  const destination = stub(200);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(null, {
        status: 302,
        headers: { Location: destination.url },
      }),
  });
  servers.push(server);
  const url = `http://127.0.0.1:${server.port}`;
  const key = "jv_redirect_never_forward";
  await stored(box, url, key);
  const output = await runJv(["logout", "--url", url], { env: box.env });
  result(output, 1, key);
  expect(output.stderr).toContain("returned an unexpected response (302)");
  expect(destination.requests()).toBe(0);
  await expectRemoved(box, url);
});
