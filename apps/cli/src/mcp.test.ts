import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { realpath } from "node:fs/promises";
import pathModule from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import {
  approvalRequestId,
  closedUrl,
  createSandbox,
  runJv,
  spawnJv,
  startVault,
} from "./test/harness";
import type { Sandbox, Vault } from "./test/harness";

let vault: Vault;
let cookie: string;
const boxes: Sandbox[] = [];
interface McpSession {
  client: Client;
  transport: StdioClientTransport;
  exited: Promise<number | null>;
  stderr: () => string;
}
const sessions: McpSession[] = [];
const logins: ReturnType<typeof spawnJv>[] = [];
const keys = new Set<string>();
const values = ["from-vault", "private-bar-value", "set-by-mcp"];
const binary = fileURLToPath(new URL("../dist/jv", import.meta.url));
const flags = ["--project", "my-app", "--env", "development"];
const scope = { projects: { "my-app": ["development"] } };

const sandbox = async () => {
  const box = await createSandbox();
  boxes.push(box);
  return { ...box, cwd: await realpath(box.env.HOME ?? "") };
};
const noLeaks = (output: unknown, printed = false) => {
  const text = JSON.stringify(output);
  for (const value of [...keys, ...(printed ? [] : values)]) {
    expect(text).not.toContain(value);
  }
};
const authenticate = async (
  box: Sandbox & { cwd: string },
  permissions = ["read", "inject", "write"],
  keyScope = scope
) => {
  const child = spawnJv(["login", "--no-browser", "--url", vault.url], box);
  logins.push(child);
  const id = approvalRequestId(await child.waitForStderr(/Open this link/u));
  const response = await vault.api("POST", `/login-requests/${id}/approve`, {
    cookie,
    body: { permissions, scope: keyScope },
  });
  expect(response.status).toBe(200);
  const loginResult = await child.exited;
  expect(loginResult.exitCode).toBe(0);
  const entries = await box.keychain();
  const key = entries.jv?.[vault.url];
  if (!key) {
    throw new Error("Expected stored key");
  }
  keys.add(key);
  return key;
};
const link = async (box: Sandbox & { cwd: string }) => {
  const output = await runJv(["link", "my-app", "--env", "development"], box);
  expect(output.exitCode).toBe(0);
};
const connectMcp = async (
  box: Sandbox & { cwd: string },
  args: string[] = [],
  supportedProtocolVersions?: string[]
) => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(box.env)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  const transport = new StdioClientTransport({
    command: binary,
    args: ["mcp", ...args],
    cwd: box.cwd,
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: "jv-test", version: "1.0.0" },
    {
      supportedProtocolVersions,
      versionNegotiation: {
        mode:
          supportedProtocolVersions?.[0] === "2026-07-28"
            ? { pin: "2026-07-28" }
            : "legacy",
      },
    }
  );
  await client.connect(transport);
  // The SDK exposes pid but not exit status; observe its spawned process for the disconnect assertion.
  const child: unknown = Reflect.get(transport, "_process");
  if (!(child instanceof ChildProcess)) {
    throw new TypeError("Expected SDK child process");
  }
  const ended = Promise.withResolvers<number | null>();
  child.once("exit", (code) => ended.resolve(code));
  const exited = ended.promise;
  const session = { client, transport, exited, stderr: () => stderr };
  sessions.push(session);
  return session;
};
const runScript = (
  client: Client,
  script: string,
  extra: Record<string, unknown> = {}
) =>
  client.callTool({
    name: "run",
    arguments: { command: [process.execPath, "-e", script], ...extra },
  });
const expectError = (output: unknown, message: string) => {
  expect(output).toMatchObject({
    isError: true,
    content: [{ type: "text", text: message }],
  });
  noLeaks(output);
};

beforeAll(async () => {
  vault = await startVault();
  ({ cookie } = await vault.signup("mcp-owner@example.com"));
  const createdProject = await vault.api("POST", "/projects", {
    cookie,
    body: { slug: "my-app", name: "My App" },
  });
  expect(createdProject.status).toBe(201);
  const createdEnvironment = await vault.api("POST", "/projects/my-app/envs", {
    cookie,
    body: { slug: "development" },
  });
  expect(createdEnvironment.status).toBe(201);
  const staging = await vault.api("POST", "/projects/my-app/envs", {
    cookie,
    body: { slug: "staging" },
  });
  expect(staging.status).toBe(201);
  await Promise.all(
    [
      ["FOO", "from-vault"],
      ["BAR", "private-bar-value"],
    ].map(async ([key, value]) => {
      const seededSecret = await vault.api(
        "PUT",
        `/projects/my-app/envs/development/secrets/${key}`,
        { cookie, body: { value } }
      );
      expect(seededSecret.status).toBe(200);
    })
  );
}, 30_000);
afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map(async (session) => {
      await session.client.close();
      noLeaks(session.stderr());
    })
  );
  await Promise.all(
    logins.splice(0).map(async (child) => {
      if (child.process.exitCode === null) {
        child.process.kill("SIGKILL");
      }
      await child.exited;
    })
  );
  await Promise.all(boxes.splice(0).map((box) => box.remove()));
});
afterAll(async () => {
  await vault?.stop();
});

test.each(["2025-11-25", "2026-07-28"])(
  "starts unconfigured and exposes exactly three tools with output schemas (%s)",
  async (version) => {
    const session = await connectMcp(await sandbox(), [], [version]);
    const surface = await session.client.listTools();
    expect(surface.tools.map((tool) => tool.name).toSorted()).toEqual([
      "list",
      "run",
      "set",
    ]);
    for (const tool of surface.tools) {
      expect(tool.outputSchema).toBeDefined();
    }
    expect(session.client.getServerCapabilities()).toEqual({
      tools: { listChanged: true },
    });
  }
);

test("injects values, preserves output and exit status, isolates stdin and keeps the connection usable", async () => {
  const box = await sandbox();
  box.env.FOO = "from-shell";
  await authenticate(box);
  await link(box);
  const { client } = await connectMcp(box);
  const output = await runScript(
    client,
    "console.log(process.env.FOO); console.error('e'); process.exit(3)"
  );
  expect(output.isError).toBeUndefined();
  expect(output.structuredContent).toEqual({
    exitCode: 3,
    stdout: "from-vault\n",
    stderr: "e\n",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
  });
  expect(output.content).toEqual([
    { type: "text", text: JSON.stringify(output.structuredContent) },
  ]);
  noLeaks(output, true);
  const quiet = await runScript(client, "console.log('ok')");
  noLeaks(quiet);
  expect(quiet.structuredContent).toMatchObject({ stdout: "ok\n" });
  const isolated = await runScript(
    client,
    "if ((await Bun.stdin.text()) !== '') process.exit(9); console.log('not json')"
  );
  expect(isolated.structuredContent).toMatchObject({
    stdout: "not json\n",
    exitCode: 0,
  });
  const listedAfterRun = await client.callTool({ name: "list", arguments: {} });
  expect(listedAfterRun.isError).toBeUndefined();
}, 15_000);

test.each([
  ["read only", ["read"], scope],
  [
    "outside scope",
    ["read", "inject"],
    { projects: { "my-app": ["staging"] } },
  ],
] as const)(
  "inject refusal never starts a child: %s",
  async (_name, permissions, keyScope) => {
    const box = await sandbox();
    await authenticate(box, [...permissions], {
      projects: { "my-app": [...keyScope.projects["my-app"]] },
    });
    await link(box);
    const { client } = await connectMcp(box);
    const marker = pathModule.join(box.cwd, "started");
    expectError(
      await runScript(
        client,
        `await Bun.write(${JSON.stringify(marker)}, 'started')`
      ),
      `The stored key for ${vault.url} cannot inject my-app/development: it lacks the inject permission or is not scoped to it. Run jv login to get a key for it.`
    );
    const exists = await Bun.file(marker).exists();
    expect(exists).toBe(false);
  },
  15_000
);

test("drains capped streams, replaces invalid UTF-8, enforces timeout and reports spawn failures", async () => {
  const box = await sandbox();
  await authenticate(box);
  const { client } = await connectMcp(box, flags);
  const large = await runScript(
    client,
    "await Promise.all([Bun.write(Bun.stdout,'x'.repeat(2097152)),Bun.write(Bun.stderr,'y'.repeat(2097152))])"
  );
  expect(large.structuredContent).toMatchObject({
    stdout: "x".repeat(1_048_576),
    stderr: "y".repeat(1_048_576),
    stdoutTruncated: true,
    stderrTruncated: true,
    timedOut: false,
    exitCode: 0,
  });
  noLeaks(large);
  const invalidUtf8 = await runScript(
    client,
    "await Bun.write(Bun.stdout,new Uint8Array([255]))"
  );
  expect(invalidUtf8.structuredContent).toMatchObject({ stdout: "�" });
  const started = Date.now();
  const timeout = await runScript(client, "setInterval(()=>{},1000)", {
    timeoutSeconds: 1,
  });
  expect(timeout.structuredContent).toMatchObject({
    timedOut: true,
    exitCode: 137,
  });
  expect(Date.now() - started).toBeLessThan(5000);
  expectError(
    await client.callTool({
      name: "run",
      arguments: { command: ["/nonexistent/jv-test-cmd"] },
    }),
    "Could not start /nonexistent/jv-test-cmd."
  );
  await Promise.all(
    [
      { command: [] },
      { command: ["x"], timeoutSeconds: 0 },
      { command: ["x"], timeoutSeconds: 601 },
      { command: ["x"], timeoutSeconds: 1.5 },
    ].map(async (arguments_) => {
      const invalidInput = await client.callTool({
        name: "run",
        arguments: arguments_,
      });
      expect(invalidInput.isError).toBe(true);
    })
  );
}, 15_000);

test("list and set return metadata only and preserve validation and permission messages", async () => {
  const box = await sandbox();
  await authenticate(box, ["read", "inject", "write"], {
    projects: { "my-app": ["development", "staging"] },
  });
  const empty = await connectMcp(box, [
    "--project",
    "my-app",
    "--env",
    "staging",
  ]);
  const emptyList = await empty.client.callTool({
    name: "list",
    arguments: {},
  });
  expect(emptyList.structuredContent).toEqual({ secrets: [] });
  noLeaks(emptyList);
  const { client } = await connectMcp(box, flags);
  const listed = await client.callTool({ name: "list", arguments: {} });
  expect(listed.structuredContent).toEqual({
    secrets: expect.arrayContaining([
      { key: "FOO", kind: "secret", version: 1, updatedAt: expect.any(String) },
      { key: "BAR", kind: "secret", version: 1, updatedAt: expect.any(String) },
    ]),
  });
  noLeaks(listed);
  const stored = await client.callTool({
    name: "set",
    arguments: { key: "NEW_KEY", value: "set-by-mcp" },
  });
  expect(stored.structuredContent).toEqual({ key: "NEW_KEY", version: 1 });
  noLeaks(stored);
  const response = await vault.api(
    "GET",
    "/projects/my-app/envs/development/secrets/NEW_KEY",
    { cookie }
  );
  expect(await response.json()).toMatchObject({ value: "set-by-mcp" });
  await Promise.all(
    [
      [
        "bad-key",
        "x",
        "Invalid secret key. Use 1 to 255 uppercase letters, digits or underscores, starting with a letter or underscore.",
      ],
      ["FOO", "x".repeat(65_537), "The value is larger than 64 KiB."],
      ["FOO", "\uD800", "The value is not valid UTF-8 text."],
    ].map(async ([key, value, message]) => {
      expectError(
        await client.callTool({ name: "set", arguments: { key, value } }),
        message ?? ""
      );
    })
  );
  const readOnly = await sandbox();
  await authenticate(readOnly, ["read"]);
  const denied = await connectMcp(readOnly, flags);
  expectError(
    await denied.client.callTool({
      name: "set",
      arguments: { key: "FOO", value: "x" },
    }),
    `The stored key for ${vault.url} lacks the write permission for my-app/development, or is not scoped to it. Run jv login to get a key with write.`
  );
}, 20_000);

test("re-resolves login, link and URL on every call", async () => {
  const box = await sandbox();
  const session = await connectMcp(box, [...flags, "--url", vault.url]);
  expectError(
    await session.client.callTool({ name: "list", arguments: {} }),
    `Not logged in to ${vault.url}. Run jv login.`
  );
  await authenticate(box);
  const listAfterLogin = await session.client.callTool({
    name: "list",
    arguments: {},
  });
  expect(listAfterLogin.isError).toBeUndefined();
  const linked = await connectMcp(box);
  expectError(
    await linked.client.callTool({ name: "list", arguments: {} }),
    "No project and environment. Run jv link <project> --env <env>, or pass --project and --env."
  );
  await link(box);
  const listAfterLink = await linked.client.callTool({
    name: "list",
    arguments: {},
  });
  expect(listAfterLink.isError).toBeUndefined();
  const empty = await sandbox();
  const envOnly = await connectMcp(empty, ["--env", "development"]);
  expectError(
    await envOnly.client.callTool({ name: "list", arguments: {} }),
    "An environment requires a project. Pass --project <p>."
  );
  const noUrl = await connectMcp(empty, flags);
  expectError(
    await noUrl.client.callTool({ name: "list", arguments: {} }),
    "No vault URL. Pass --url <url>, set JV_URL, or log in once with --url."
  );
  await authenticate(empty);
  const listAfterUrl = await noUrl.client.callTool({
    name: "list",
    arguments: {},
  });
  expect(listAfterUrl.isError).toBeUndefined();
}, 20_000);

test("vault failures retain exact messages without leaking bodies or starting commands", async () => {
  const seed = await sandbox();
  const key = await authenticate(seed);
  await Promise.all(
    [401, 403, 404, 500, 200, 0].map(async (status) => {
      const box = await sandbox();
      const server =
        status === 0
          ? undefined
          : Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: () =>
                new Response("malformed from-vault private-bar-value", {
                  status,
                }),
            });
      const url = server
        ? `http://127.0.0.1:${server.port}`
        : await closedUrl();
      await Bun.write(
        pathModule.join(box.env.JV_TEST_KEYCHAIN ?? "", "keychain.json"),
        JSON.stringify({ jv: { [url]: key } })
      );
      try {
        const { client } = await connectMcp(box, [...flags, "--url", url]);
        const marker = pathModule.join(box.cwd, "started");
        await Promise.all(
          ["run", "list", "set"].map(async (name) => {
            let message = `The vault at ${url} returned an unexpected response (${status}).`;
            if (status === 0) {
              message = `Could not reach the vault at ${url}.`;
            } else if (status === 401) {
              message = `The vault at ${url} rejected the stored key. Run jv login again.`;
            } else if (status === 404) {
              message = `Project my-app or environment development not found at ${url}.`;
            } else if (status === 403) {
              const permission = name === "list" ? "read" : "write";
              message =
                name === "run"
                  ? `The stored key for ${url} cannot inject my-app/development: it lacks the inject permission or is not scoped to it. Run jv login to get a key for it.`
                  : `The stored key for ${url} lacks the ${permission} permission for my-app/development, or is not scoped to it. Run jv login to get a key with ${permission}.`;
            }
            let args = {};
            if (name === "run") {
              args = {
                command: [
                  process.execPath,
                  "-e",
                  `await Bun.write(${JSON.stringify(marker)}, 'started')`,
                ],
              };
            } else if (name === "set") {
              args = { key: "FOO", value: "private-bar-value" };
            }
            expectError(
              await client.callTool({ name, arguments: args }),
              message
            );
          })
        );
        expect(await Bun.file(marker).exists()).toBe(false);
      } finally {
        await server?.stop(true);
      }
    })
  );
}, 15_000);

const waitForPid = async (file: string) => {
  const ready = Promise.withResolvers<undefined>();
  const watcher = watch(pathModule.dirname(file), () => ready.resolve());
  try {
    if (!(await Bun.file(file).exists())) {
      await ready.promise;
    }
    return Number(await Bun.file(file).text());
  } finally {
    watcher.close();
  }
};
test.each(["disconnect", "SIGINT", "SIGTERM"] as const)(
  "%s kills an active child and exits cleanly",
  async (mode) => {
    const box = await sandbox();
    await authenticate(box);
    const session = await connectMcp(box, flags);
    const file = pathModule.join(box.cwd, "child.pid");
    const ready = waitForPid(file);
    const pending = runScript(
      session.client,
      `await Bun.write(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000)`
    ).catch(() => {});
    const pid = await ready;
    if (mode === "disconnect") {
      await session.client.close();
    } else if (session.transport.pid) {
      process.kill(session.transport.pid, mode);
    }
    expect(await session.exited).toBe(0);
    await pending;
    expect(() => process.kill(pid, 0)).toThrow();
  },
  15_000
);

test("usage rejects invalid arguments before serving and help lists mcp", async () => {
  const box = await sandbox();
  await Promise.all(
    [
      ["extra"],
      ["--"],
      ["--no-browser"],
      ["--unknown"],
      ["--project", "BAD"],
      ["--env", "BAD"],
      ["--url", "ftp://x"],
    ].map(async (args) => {
      const output = await runJv(["mcp", ...args], box);
      expect(output.exitCode).toBe(2);
      expect(output.stdout).toBe("");
      let message = "Usage:";
      if (args.includes("BAD")) {
        message = "Invalid project or environment:";
      } else if (args.includes("ftp://x")) {
        message = "Invalid vault URL";
      }
      expect(output.stderr).toContain(message);
    })
  );
  await Promise.all(
    [["help"], ["--help"], ["mcp", "--help"]].map(async (args) => {
      const output = await runJv(args, box);
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toContain(
        "jv mcp [--project <p>] [--env <e>] [--url <u>]"
      );
      expect(output.stdout).toContain(
        "mcp      Serve run, list and set tools to an MCP client over stdio"
      );
    })
  );
});
