import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pathModule from "node:path";
import { fileURLToPath } from "node:url";

import { createVaultApiHandler } from "@jomans-vault/api/handler";
import { createAuth } from "@jomans-vault/auth";
import { createDb } from "@jomans-vault/db";
import type { Database } from "@jomans-vault/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as z from "zod";

interface ApiOptions {
  cookie?: string;
  apiKey?: string;
  body?: unknown;
}
export interface Vault {
  url: string;
  db: Database;
  signup: (email: string) => Promise<{ id: string; cookie: string }>;
  api: (
    method: string,
    path: string,
    options?: ApiOptions
  ) => Promise<Response>;
  stop: () => Promise<void>;
}

export const startVault = async (): Promise<Vault> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("CLI tests require DATABASE_URL for an isolated database");
  }
  const databaseName = `jv_cli_${crypto.randomUUID().replaceAll("-", "")}`;
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = createDb({ DATABASE_URL: isolatedUrl.toString() });
  let handler: ReturnType<typeof createVaultApiHandler> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      handler?.(request) ?? new Response("Starting", { status: 503 }),
  });
  const url = `http://127.0.0.1:${server.port}`;
  let created = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      try {
        await server.stop(true);
      } finally {
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
      }
    })();
    return stopping;
  };
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL("../../../../packages/db/src/migrations", import.meta.url)
      ),
    });
    const auth = createAuth(
      {
        BETTER_AUTH_URL: url,
        BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
      },
      db
    );
    handler = createVaultApiHandler({
      db,
      auth,
      masterKey: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32))
      ).toString("base64"),
    });
    return {
      url,
      db,
      stop,
      signup: async (email) => {
        const response = await auth.handler(
          new Request(`${url}/api/auth/sign-up/email`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: url },
            body: JSON.stringify({
              email,
              name: "CLI Tester",
              password: crypto.randomUUID(),
            }),
          })
        );
        if (!response.ok) {
          throw new Error(`Signup failed: ${response.status}`);
        }
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
      },
      api: async (method, path, options = {}) => {
        const headers = new Headers({ "Content-Type": "application/json" });
        if (options.cookie) {
          headers.set("cookie", options.cookie);
        }
        if (options.apiKey) {
          headers.set("x-api-key", options.apiKey);
        }
        return await fetch(`${url}/api/v1${path}`, {
          method,
          headers,
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
        });
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
};

export interface Sandbox {
  env: NodeJS.ProcessEnv;
  keychain: () => Promise<Record<string, Record<string, string>>>;
  remove: () => Promise<void>;
}
export const createSandbox = async (): Promise<Sandbox> => {
  const root = await mkdtemp(pathModule.join(tmpdir(), "jv-cli-"));
  const home = pathModule.join(root, "home");
  const config = pathModule.join(root, "config");
  const keychain = pathModule.join(root, "keychain");
  await Promise.all([home, config, keychain].map((dir) => mkdir(dir)));
  return {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: config,
      JV_TEST_KEYCHAIN: keychain,
      PATH: "/usr/bin:/bin",
    },
    keychain: async () => {
      const file = Bun.file(pathModule.join(keychain, "keychain.json"));
      return (await file.exists())
        ? z
            .record(z.string(), z.record(z.string(), z.string()))
            .parse(JSON.parse(await file.text()))
        : {};
    },
    remove: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};

export interface JvResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
const binary = fileURLToPath(new URL("../../dist/jv", import.meta.url));
export const spawnJv = (
  args: string[],
  { env, cwd }: { env: NodeJS.ProcessEnv; cwd?: string }
) => {
  const process = Bun.spawn([binary, ...args], {
    env,
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderr = "";
  const listeners = new Set<() => void>();
  const readStderr = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of process.stderr) {
      stderr += decoder.decode(chunk, { stream: true });
      for (const listener of listeners) {
        listener();
      }
    }
    stderr += decoder.decode();
  })();
  const stdout = (async () =>
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await new Response(process.stdout).arrayBuffer()
    ))();
  const exited = (async (): Promise<JvResult> => {
    const exitCode = await process.exited;
    await readStderr;
    return { exitCode, stdout: await stdout, stderr };
  })();
  return {
    process,
    exited,
    waitForExit: () => exited,
    waitForStderr: async (
      pattern: RegExp,
      timeoutMs = 15_000
    ): Promise<string> => {
      const deferred = Promise.withResolvers<string>();
      const inspect = () => {
        const line = stderr.split("\n").find((value) => pattern.test(value));
        if (line !== undefined) {
          listeners.delete(inspect);
          deferred.resolve(line);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(inspect);
        deferred.reject(
          new Error(`Timed out waiting for ${pattern}: ${stderr}`)
        );
      }, timeoutMs);
      listeners.add(inspect);
      inspect();
      try {
        return await deferred.promise;
      } finally {
        clearTimeout(timer);
        listeners.delete(inspect);
      }
    },
  };
};
export const runJv = async (
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string }
): Promise<JvResult> => {
  const child = spawnJv(args, options);
  child.process.stdin.end();
  return await child.exited;
};

export const approvalRequestId = (stderr: string): string => {
  const match = /Open this link to approve this machine: (?<link>\S+)/u.exec(
    stderr
  );
  const id = match?.groups?.link
    ? new URL(match.groups.link).searchParams.get("request")
    : null;
  if (!id) {
    throw new Error("No approval request id in stderr");
  }
  return id;
};

export const runJvInTerminal = async (
  args: string[],
  {
    env,
    cwd,
    input,
    inputDelayMs = 200,
  }: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    input?: string;
    inputDelayMs?: number;
  }
): Promise<{ exitCode: number; output: string }> => {
  let output = "";
  const decoder = new TextDecoder();
  const ended = Promise.withResolvers<undefined>();
  const child = Bun.spawn([binary, ...args], {
    env,
    cwd,
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal, data) => {
        output += decoder.decode(data, { stream: true });
      },
      exit: () => ended.resolve(),
    },
  });
  const { terminal } = child;
  if (!terminal) {
    child.kill("SIGKILL");
    throw new Error("Expected a pseudo-terminal");
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const inputTimer =
    input === undefined
      ? undefined
      : setTimeout(() => terminal.write(input), inputDelayMs);
  try {
    const exitCode = await child.exited;
    await ended.promise;
    output += decoder.decode();
    return { exitCode, output };
  } finally {
    clearTimeout(timer);
    clearTimeout(inputTimer);
    terminal.close();
  }
};
