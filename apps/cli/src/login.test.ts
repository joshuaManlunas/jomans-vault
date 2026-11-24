import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import pathModule from "node:path";

import { loginRequest } from "@jomans-vault/db/schema/vault";
import { eq } from "drizzle-orm";
import * as z from "zod";

import {
  approvalRequestId,
  createSandbox,
  runJv,
  spawnJv,
  startVault,
} from "./test/harness";
import type { JvResult, Sandbox, Vault } from "./test/harness";

const warning =
  "warning: JV_TEST_KEYCHAIN is set; using a test keychain instead of the OS keychain. Never set it outside tests.";
const scope = { projects: { "my-app": ["development"] } };
let vault: Vault;
let cookie: string;
const sandboxes: Sandbox[] = [];
const children: ReturnType<typeof spawnJv>[] = [];
const sandbox = async () => {
  const box = await createSandbox();
  sandboxes.push(box);
  return box;
};
const spawn = (args: string[], env: NodeJS.ProcessEnv) => {
  const child = spawnJv(args, { env });
  children.push(child);
  return child;
};
const result = (value: JvResult, exitCode: number) => {
  expect(value.exitCode).toBe(exitCode);
  expect(value.stderr).toContain(warning);
  expect(value.stdout).toBe("");
};
const configPath = (box: Sandbox, name: string) =>
  pathModule.join(box.env.XDG_CONFIG_HOME ?? "", "jv", name);
const noStorage = async (box: Sandbox) => {
  expect(await box.keychain()).toEqual({});
  expect(await Bun.file(configPath(box, "credentials.json")).exists()).toBe(
    false
  );
  expect(await Bun.file(configPath(box, "config.json")).exists()).toBe(false);
};
const filesUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = pathModule.join(dir, entry.name);
      return entry.isDirectory() ? await filesUnder(path) : [path];
    })
  );
  return files.flat();
};
const mode = async (path: string) => {
  const info = await stat(path);
  return info.mode % 0o1000;
};
const storedKey = async (box: Sandbox) => {
  const entries = await box.keychain();
  return entries.jv?.[vault.url];
};
const expectStatus = async (pending: Promise<Response>, status: number) => {
  const response = await pending;
  expect(response.status).toBe(status);
};
const begin = async (box: Sandbox, url = vault.url) => {
  const child = spawn(["login", "--no-browser", "--url", url], box.env);
  const line = await child.waitForStderr(/Open this link/u);
  return { child, id: approvalRequestId(line) };
};
const approve = async (id: string) => {
  await expectStatus(
    vault.api("POST", `/login-requests/${id}/approve`, {
      cookie,
      body: { scope },
    }),
    200
  );
};
const approved = async (box: Sandbox, url = vault.url) => {
  const pending = await begin(box, url);
  await approve(pending.id);
  const output = await pending.child.waitForExit();
  result(output, 0);
  return output;
};
const closedUrl = async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const url = `http://127.0.0.1:${server.port}`;
  await server.stop(true);
  return url;
};

beforeAll(async () => {
  vault = await startVault();
  ({ cookie } = await vault.signup("cli-owner@example.com"));
  await Promise.all(
    ["my-app", "outside-scope"].map(async (slug) => {
      await expectStatus(
        vault.api("POST", "/projects", { cookie, body: { slug, name: slug } }),
        201
      );
      await expectStatus(
        vault.api("POST", `/projects/${slug}/envs`, {
          cookie,
          body: { slug: "development" },
        }),
        201
      );
    })
  );
}, 30_000);
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.process.exitCode === null) {
        child.process.kill();
      }
      await child.exited;
    })
  );
  await Promise.all(sandboxes.splice(0).map((box) => box.remove()));
});
afterAll(async () => {
  await vault?.stop();
});

test("approved login opens only the link, stores a working scoped key, and leaks no key", async () => {
  const box = await sandbox();
  const bin = pathModule.join(box.env.HOME ?? "", "bin");
  const argumentsPath = pathModule.join(bin, "arguments");
  await mkdir(bin);
  await Promise.all(
    ["open", "xdg-open"].map(async (name) => {
      await writeFile(
        pathModule.join(bin, name),
        `#!/bin/sh\nprintf '%s\\n' "$#" "$@" > '${argumentsPath}'\nexit 1\n`,
        { mode: 0o700 }
      );
    })
  );
  const child = spawn(["login", "--url", `${vault.url}/`], {
    ...box.env,
    PATH: `${bin}:${box.env.PATH}`,
  });
  const line = await child.waitForStderr(/Open this link/u);
  const id = approvalRequestId(line);
  const link = `${vault.url}/cli/authorize?request=${id}`;
  expect(line).toBe(`Open this link to approve this machine: ${link}`);
  const [row] = await vault.db
    .select()
    .from(loginRequest)
    .where(eq(loginRequest.id, id));
  expect(row).toMatchObject({
    machineName: hostname().trim().slice(0, 32) || "jv",
    project: null,
    environment: null,
    status: "pending",
  });
  await approve(id);
  const output = await child.waitForExit();
  result(output, 0);
  expect(output.stderr).toContain(
    `Logged in to ${vault.url}. Key stored in the OS keychain.`
  );
  const key = await storedKey(box);
  expect(key).toMatch(/^jv_/u);
  if (!key) {
    throw new Error("Expected a stored key");
  }
  expect(await readFile(argumentsPath, "utf-8")).toBe(`1\n${link}\n`);
  expect(output.stderr + output.stdout).not.toContain(key);
  await expectStatus(
    vault.api("GET", "/projects/my-app/envs/development/secrets", {
      apiKey: key,
    }),
    200
  );
  await expectStatus(
    vault.api("GET", "/projects/outside-scope/envs/development/secrets", {
      apiKey: key,
    }),
    403
  );
  const fileGroups = await Promise.all(
    [box.env.HOME, box.env.XDG_CONFIG_HOME].map((dir) => filesUnder(dir ?? ""))
  );
  const files = fileGroups.flat();
  await Promise.all(
    files.map(async (path) => {
      expect(await readFile(path, "utf-8")).not.toContain(key);
    })
  );
  expect(await Bun.file(configPath(box, "config.json")).json()).toEqual({
    url: vault.url,
  });
  expect(
    await mode(pathModule.join(box.env.JV_TEST_KEYCHAIN ?? "", "keychain.json"))
  ).toBe(0o600);
}, 15_000);

test("unavailable keychain writes private fallback; a later keychain login removes the stale file", async () => {
  const box = await sandbox();
  const testKeychain = box.env.JV_TEST_KEYCHAIN;
  box.env.JV_TEST_KEYCHAIN = "unavailable";
  const first = await approved(box);
  const path = configPath(box, "credentials.json");
  const entries = z
    .record(z.string(), z.string())
    .parse(await Bun.file(path).json());
  expect(entries[vault.url]).toMatch(/^jv_/u);
  expect(await mode(path)).toBe(0o600);
  expect(await mode(configPath(box, "."))).toBe(0o700);
  expect(first.stderr).toContain(
    `warning: the OS keychain is unavailable; the key was stored in ${path} (readable only by you).`
  );
  expect(first.stderr).toContain(`Key stored in ${path}.`);
  expect(first.stderr).not.toContain(entries[vault.url] ?? "missing");
  await chmod(path, 0o644);
  await chmod(configPath(box, "."), 0o755);
  await approved(box);
  expect(await mode(path)).toBe(0o600);
  expect(await mode(configPath(box, "."))).toBe(0o700);
  box.env.JV_TEST_KEYCHAIN = testKeychain;
  await approved(box);
  expect(await Bun.file(path).exists()).toBe(false);
  expect(await storedKey(box)).toMatch(/^jv_/u);
}, 15_000);

test("keychain storage removes only this vault's fallback entry", async () => {
  const box = await sandbox();
  const path = configPath(box, "credentials.json");
  await mkdir(configPath(box, "."));
  await Bun.write(
    path,
    JSON.stringify({ [vault.url]: "stale", "https://other.example": "keep" })
  );
  await approved(box);
  expect(await Bun.file(path).json()).toEqual({
    "https://other.example": "keep",
  });
  expect(await mode(path)).toBe(0o600);
}, 15_000);

test.each(["denied", "expired"] as const)(
  "%s login stores nothing",
  async (status) => {
    const box = await sandbox();
    const { child, id } = await begin(box);
    await (status === "denied"
      ? expectStatus(
          vault.api("POST", `/login-requests/${id}/deny`, { cookie }),
          200
        )
      : vault.db
          .update(loginRequest)
          .set({ expiresAt: new Date(0) })
          .where(eq(loginRequest.id, id)));
    const output = await child.waitForExit();
    result(output, 1);
    expect(output.stderr).toContain(
      status === "denied"
        ? "The login request was denied. Nothing was stored."
        : "The login request expired before it was approved. Run jv login again."
    );
    await noStorage(box);
  },
  15_000
);

test("denial preserves previous credentials and remembered URL", async () => {
  const box = await sandbox();
  await approved(box);
  const before = await box.keychain();
  const config = await Bun.file(configPath(box, "config.json")).text();
  const { child, id } = await begin(box);
  await expectStatus(
    vault.api("POST", `/login-requests/${id}/deny`, { cookie }),
    200
  );
  result(await child.waitForExit(), 1);
  expect(await box.keychain()).toEqual(before);
  expect(await Bun.file(configPath(box, "config.json")).text()).toBe(config);
}, 15_000);

test("closed vault and a vault stopped during polling are unreachable and store nothing", async () => {
  const box = await sandbox();
  const url = await closedUrl();
  const output = await runJv(["login", "--no-browser", "--url", url], {
    env: box.env,
  });
  result(output, 1);
  expect(output.stderr).toContain(`Could not reach the vault at ${url}.`);
  await noStorage(box);
  const temporaryVault = await startVault();
  try {
    const { child } = await begin(box, temporaryVault.url);
    await temporaryVault.stop();
    const stopped = await child.waitForExit();
    result(stopped, 1);
    expect(stopped.stderr).toContain(
      `Could not reach the vault at ${temporaryVault.url}.`
    );
    await noStorage(box);
  } finally {
    await temporaryVault.stop();
  }
}, 20_000);

test("URL precedence, normalization, usage errors and help (table driven)", async () => {
  const flagUrl = await closedUrl();
  const envUrl = await closedUrl();
  const remembered = await closedUrl();
  const cases = [
    {
      args: ["login", "--url", flagUrl],
      envUrl,
      remembered,
      code: 1,
      message: `Could not reach the vault at ${flagUrl}.`,
    },
    {
      args: ["login"],
      envUrl,
      remembered,
      code: 1,
      message: `Could not reach the vault at ${envUrl}.`,
    },
    {
      args: ["login"],
      remembered,
      code: 1,
      message: `Could not reach the vault at ${remembered}.`,
    },
    {
      args: ["login"],
      envUrl: "",
      remembered,
      code: 1,
      message: `Could not reach the vault at ${remembered}.`,
    },
    {
      args: ["login", "--url", `${flagUrl}///?ignored=yes#hash`],
      code: 1,
      message: `Could not reach the vault at ${flagUrl}.`,
    },
    {
      args: ["login"],
      code: 2,
      message:
        "No vault URL. Pass --url <url>, set JV_URL, or log in once with --url.",
    },
    {
      args: ["login", "--url", "ftp://x"],
      code: 2,
      message: 'Invalid vault URL "ftp://x": use an http:// or https:// URL.',
    },
    {
      args: ["login", "--url", "not a url"],
      code: 2,
      message: 'Invalid vault URL "not a url": use an http:// or https:// URL.',
    },
    {
      args: ["login", "--url", ""],
      code: 2,
      message: 'Invalid vault URL "": use an http:// or https:// URL.',
    },
    { args: ["unknown"], code: 2, message: "Usage:" },
    { args: ["login", "--unknown"], code: 2, message: "Usage:" },
    { args: ["login", "--url"], code: 2, message: "Usage:" },
    { args: [], code: 2, message: "Usage:" },
    { args: ["--help"], code: 0, message: "Usage:", help: true },
    { args: ["help"], code: 0, message: "Usage:", help: true },
    { args: ["login", "--help"], code: 0, message: "Usage:", help: true },
    {
      args: ["--help"],
      testKeychain: "relative/path",
      code: 2,
      message: "Invalid JV_TEST_KEYCHAIN",
    },
  ];
  await Promise.all(
    cases.map(async (entry) => {
      const box = await sandbox();
      if (entry.remembered) {
        await mkdir(configPath(box, "."));
        await Bun.write(
          configPath(box, "config.json"),
          JSON.stringify({ url: entry.remembered })
        );
      }
      const output = await runJv(
        [...entry.args, ...(entry.help ? [] : ["--no-browser"])],
        {
          env: {
            ...box.env,
            JV_URL: entry.envUrl,
            JV_TEST_KEYCHAIN: entry.testKeychain ?? box.env.JV_TEST_KEYCHAIN,
          },
        }
      );
      expect(output.exitCode).toBe(entry.code);
      expect(output.stderr).toContain(warning);
      expect(entry.help ? output.stdout : output.stderr).toContain(
        entry.message
      );
      if (entry.help) {
        for (const text of ["login", "--url", "--no-browser"]) {
          expect(output.stdout).toContain(text);
        }
      } else {
        expect(output.stdout).toBe("");
      }
      expect(await box.keychain()).toEqual({});
      expect(await Bun.file(configPath(box, "credentials.json")).exists()).toBe(
        false
      );
      if (entry.remembered) {
        expect(await Bun.file(configPath(box, "config.json")).json()).toEqual({
          url: entry.remembered,
        });
      } else {
        expect(await Bun.file(configPath(box, "config.json")).exists()).toBe(
          false
        );
      }
    })
  );
}, 20_000);

test("relative XDG_CONFIG_HOME falls back to HOME/.config/jv and no-browser skips the opener", async () => {
  const box = await sandbox();
  box.env.XDG_CONFIG_HOME = "relative";
  const bin = pathModule.join(box.env.HOME ?? "", "bin");
  const marker = pathModule.join(bin, "opened");
  await mkdir(bin);
  await Promise.all(
    ["open", "xdg-open"].map(async (name) => {
      await writeFile(
        pathModule.join(bin, name),
        `#!/bin/sh\ntouch '${marker}'\n`,
        {
          mode: 0o700,
        }
      );
    })
  );
  box.env.PATH = `${bin}:${box.env.PATH}`;
  await approved(box);
  expect(await Bun.file(marker).exists()).toBe(false);
  const remembered = pathModule.join(
    box.env.HOME ?? "",
    ".config/jv/config.json"
  );
  expect(await Bun.file(remembered).json()).toEqual({ url: vault.url });
}, 15_000);

test("a collected poll returns unexpected 409 without storing anything", async () => {
  const box = await sandbox();
  const { child, id } = await begin(box);
  await vault.db
    .update(loginRequest)
    .set({ status: "collected" })
    .where(eq(loginRequest.id, id));
  const output = await child.waitForExit();
  result(output, 1);
  expect(output.stderr).toContain(
    `The vault at ${vault.url} returned an unexpected response (409).`
  );
  await noStorage(box);
}, 15_000);

test("unexpected opening status, malformed JSON and invalid response shapes store nothing", async () => {
  await Promise.all(
    [
      new Response("Not found", { status: 404 }),
      new Response("not json"),
      Response.json({ id: "missing-other-fields" }),
    ].map(async (response) => {
      const box = await sandbox();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => response,
      });
      const url = `http://127.0.0.1:${server.port}`;
      try {
        const output = await runJv(["login", "--no-browser", "--url", url], {
          env: box.env,
        });
        result(output, 1);
        expect(output.stderr).toContain(
          `The vault at ${url} returned an unexpected response (${response.status}).`
        );
        await noStorage(box);
      } finally {
        await server.stop(true);
      }
    })
  );
});

test("ten-second network timeout applies to opening and polling", async () => {
  await Promise.all(
    ["open", "poll", "body"].map(async (phase) => {
      const box = await sandbox();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          if (
            phase === "poll" &&
            new URL(request.url).pathname.endsWith("/login-requests")
          ) {
            return Response.json(
              {
                id: "timeout-test",
                pollingSecret: "secret",
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              },
              { status: 201 }
            );
          }
          if (phase === "body") {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"id":'));
                },
              })
            );
          }
          return Promise.withResolvers<Response>().promise;
        },
      });
      const url = `http://127.0.0.1:${server.port}`;
      try {
        const started = Date.now();
        const child = spawn(["login", "--no-browser", "--url", url], box.env);
        const output = await child.waitForExit();
        result(output, 1);
        expect(Date.now() - started).toBeGreaterThanOrEqual(9900);
        expect(output.stderr).toContain(`Could not reach the vault at ${url}.`);
        await noStorage(box);
      } finally {
        await server.stop(true);
      }
    })
  );
}, 30_000);
