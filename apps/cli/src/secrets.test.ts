import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import pathModule from "node:path";

import { loginRequest } from "@jomans-vault/db/schema/vault";
import { eq } from "drizzle-orm";

import {
  approvalPairingCode,
  approvalRequestId,
  createSandbox,
  runJv,
  runJvInTerminal,
  spawnJv,
  startVault,
} from "./test/harness";
import type { JvResult, Sandbox, Vault } from "./test/harness";

let vault: Vault;
let cookie: string;
const boxes: Sandbox[] = [];
const children: ReturnType<typeof spawnJv>[] = [];
const keys = new Set<string>();
const values = [
  "argument-secret",
  "a b\nc\n",
  "\uFEFFleading-bom",
  "typed-secret",
];
const warning =
  "warning: JV_TEST_KEYCHAIN is set; using a test keychain instead of the OS keychain. Never set it outside tests.\n";
const target = ["--project", "my-app", "--env", "development"];
const commands = ["ls", "get", "set", "rm", "history"] as const;
type Command = (typeof commands)[number];
type Box = Sandbox & { cwd: string };

const sandbox = async (): Promise<Box> => {
  const box = await createSandbox();
  boxes.push(box);
  return { ...box, cwd: await realpath(box.env.HOME ?? "") };
};
const spawn = (args: string[], box: Box) => {
  const child = spawnJv(args, box);
  children.push(child);
  return child;
};
const stderr = (result: JvResult) => {
  expect(result.stderr.startsWith(warning)).toBe(true);
  return result.stderr.slice(warning.length);
};
const noLeaks = (result: JvResult, reveals = false) => {
  for (const value of [...keys, ...values]) {
    expect(result.stderr).not.toContain(value);
    if (!reveals) {
      expect(result.stdout).not.toContain(value);
    }
  }
};
const authenticate = async (
  box: Box,
  permissions = ["read", "reveal", "write", "delete"],
  environments = ["development", "staging", "empty"]
) => {
  const child = spawn(["login", "--no-browser", "--url", vault.url], box);
  const id = approvalRequestId(await child.waitForStderr(/Open this link/u));
  const pairingCode = approvalPairingCode(
    await child.waitForStderr(/Enter this pairing code/u)
  );
  const approved = await vault.api("POST", `/login-requests/${id}/approve`, {
    cookie,
    body: {
      pairingCode,
      scope: { projects: { "my-app": environments } },
      permissions,
    },
  });
  expect(approved.status).toBe(200);
  const result = await child.exited;
  expect(result.exitCode).toBe(0);
  const entries = await box.keychain();
  const key = entries.jv?.[vault.url];
  if (!key) {
    throw new Error("Expected stored credentials");
  }
  keys.add(key);
  noLeaks(result);
  const [row] = await vault.db
    .select()
    .from(loginRequest)
    .where(eq(loginRequest.id, id));
  if (!row?.apiKeyId) {
    throw new Error("Expected approved API key id");
  }
  return { key, id: row.apiKeyId };
};
const store = async (box: Box, url: string, key: string) => {
  const entries = await box.keychain();
  await writeFile(
    pathModule.join(box.env.JV_TEST_KEYCHAIN ?? "", "keychain.json"),
    JSON.stringify({ jv: { ...entries.jv, [url]: key } })
  );
};
const argsFor = (command: Command) => {
  if (command === "ls") {
    return [command];
  }
  if (command === "set") {
    return [command, "FOO", "argument-secret"];
  }
  return [command, "FOO"];
};
const expectOutput = async (
  pending: Promise<JvResult>,
  expected: Partial<JvResult>
) => {
  const result = await pending;
  expect({ ...result, stderr: stderr(result) }).toMatchObject({
    exitCode: 0,
    ...expected,
  });
  return result;
};
const expectStatus = async (pending: Promise<Response>, status: number) => {
  const response = await pending;
  expect(response.status).toBe(status);
};
const invoke = async (
  box: Box,
  args: string[],
  input?: string | Uint8Array
) => {
  const child = spawn(args, box);
  if (input !== undefined) {
    child.process.stdin.write(input);
  }
  child.process.stdin.end();
  const result = await child.exited;
  noLeaks(result, args[0] === "get");
  return result;
};
const run = async (box: Box, args: string[], input?: string | Uint8Array) =>
  await invoke(box, [...args, ...target, "--url", vault.url], input);

beforeAll(async () => {
  vault = await startVault();
  ({ cookie } = await vault.signup("secrets-owner@example.com"));
  await expectStatus(
    vault.api("POST", "/projects", {
      cookie,
      body: { slug: "my-app", name: "My app" },
    }),
    201
  );
  await Promise.all(
    ["development", "staging", "empty"].map(async (env) => {
      await expectStatus(
        vault.api("POST", "/projects/my-app/envs", {
          cookie,
          body: { slug: env },
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

test("round trip preserves bytes, lists only metadata, records history and removes without prompting", async () => {
  const box = await sandbox();
  const { id } = await authenticate(box);
  await expectOutput(
    runJv(["link", "my-app", "--env", "development"], box),
    {}
  );
  const nested = pathModule.join(box.cwd, "nested");
  await mkdir(nested);
  const linkedBox = { ...box, cwd: nested };
  const first = await invoke(linkedBox, ["set", "FOO", "argument-secret"]);
  expect(first.exitCode).toBe(0);
  expect(first.stdout).toBe("");
  expect(stderr(first)).toBe("Stored FOO in my-app/development (version 1).\n");
  const second = await invoke(linkedBox, ["set", "FOO", "-"], "a b\nc\n");
  expect(second.exitCode).toBe(0);
  expect(stderr(second)).toBe(
    "Stored FOO in my-app/development (version 2).\n"
  );
  const get = await invoke(linkedBox, ["get", "FOO"]);
  expect(get.stdout).toBe("a b\nc\n");
  expect(stderr(get)).toBe("");
  const bom = await run(box, ["set", "BOM", "-"], "\uFEFFleading-bom");
  expect(bom.exitCode).toBe(0);
  await expectOutput(run(box, ["get", "BOM"]), {
    stdout: "\uFEFFleading-bom",
    stderr: "",
  });
  const boundary = `${"界".repeat(21_845)}a`;
  await expectOutput(run(box, ["set", "LIMIT", "-"], boundary), {});
  await expectOutput(run(box, ["get", "LIMIT"]), { stdout: boundary });
  await expectOutput(run(box, ["set", "EMPTY_VALUE", ""]), {});
  await expectOutput(run(box, ["get", "EMPTY_VALUE"]), { stdout: "" });
  const listed = await invoke(linkedBox, ["ls"]);
  expect(listed.exitCode).toBe(0);
  expect(stderr(listed)).toBe("");
  expect(
    listed.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/u).slice(0, 3))
  ).toEqual([
    ["BOM", "secret", "v1"],
    ["EMPTY_VALUE", "secret", "v1"],
    ["FOO", "secret", "v2"],
    ["LIMIT", "secret", "v1"],
  ]);
  expect(listed.stdout).toMatch(
    /^FOO {10}secret {2}v2 {2}\d{4}-\d{2}-\d{2}T[^\n]+Z$/mu
  );
  const history = await run(box, ["history", "FOO"]);
  expect(history.exitCode).toBe(0);
  expect(history.stdout.trim().split("\n")).toEqual([
    expect.stringMatching(new RegExp(`^v1  \\S+Z  apiKey ${id}$`, "u")),
    expect.stringMatching(new RegExp(`^v2  \\S+Z  apiKey ${id}$`, "u")),
  ]);
  const removed = await run(box, ["rm", "FOO"]);
  expect(removed.exitCode).toBe(0);
  expect(removed.stdout).toBe("");
  expect(stderr(removed)).toBe("Removed FOO from my-app/development.\n");
  const after = await run(box, ["ls"]);
  expect(after.stdout).not.toContain("FOO");
  await expectOutput(run(box, ["history", "FOO"]), { stdout: history.stdout });
  const empty = await invoke(box, [
    "ls",
    "--project",
    "my-app",
    "--env",
    "empty",
    "--url",
    vault.url,
  ]);
  expect(empty.exitCode).toBe(0);
  expect(empty.stdout).toBe("");
  expect(stderr(empty)).toBe("No secrets in my-app/empty.\n");
  const override = await invoke(linkedBox, [
    "set",
    "OVERRIDE",
    "argument-secret",
    "--env",
    "staging",
  ]);
  expect(override.exitCode).toBe(0);
  expect(stderr(override)).toBe(
    "Stored OVERRIDE in my-app/staging (version 1).\n"
  );
}, 20_000);

test("failure matrix reports fixed messages without leaking keys, values or response bodies", async () => {
  const box = await sandbox();
  const unauthenticated = await sandbox();
  const forbidden = await sandbox();
  await expectStatus(
    vault.api("POST", "/projects/my-app/envs", {
      cookie,
      body: { slug: "missing" },
    }),
    201
  );
  const { key } = await authenticate(box, undefined, [
    "development",
    "staging",
    "empty",
    "missing",
  ]);
  await authenticate(forbidden, ["inject"]);
  await expectStatus(
    vault.api("DELETE", "/projects/my-app/envs/missing", { cookie }),
    204
  );
  const bogus = await sandbox();
  await store(bogus, vault.url, "bogus-key");
  keys.add("bogus-key");
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const closed = `http://127.0.0.1:${stub.port}`;
  await stub.stop(true);
  const servers = [409, 500, 302, 200, 201].map((status) => ({
    status,
    server: Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ value: "argument-secret" }, { status }),
    }),
  }));
  await writeFile(
    pathModule.join(box.env.JV_TEST_KEYCHAIN ?? "", "keychain.json"),
    JSON.stringify({
      jv: {
        [vault.url]: key,
        [closed]: key,
        ...Object.fromEntries(
          servers.map(({ server }) => [`http://127.0.0.1:${server.port}`, key])
        ),
      },
    })
  );
  try {
    await Promise.all(
      commands.map(async (command) => {
        const permission = {
          ls: "read",
          get: "reveal",
          set: "write",
          rm: "delete",
          history: "read",
        }[command];
        const keyMissingMessage = (env: string) =>
          `Secret FOO not found in my-app/${env} at ${vault.url}, or the project or environment does not exist.`;
        const missingMessage =
          command === "ls" || command === "set"
            ? `Project my-app or environment missing not found at ${vault.url}.`
            : keyMissingMessage("missing");
        const cases = [
          {
            box: unauthenticated,
            url: vault.url,
            env: "development",
            message: `Not logged in to ${vault.url}. Run jv login.`,
          },
          {
            box,
            url: closed,
            env: "development",
            message: `Could not reach the vault at ${closed}.`,
          },
          {
            box: bogus,
            url: vault.url,
            env: "development",
            message: `The vault at ${vault.url} rejected the stored key. Run jv login again.`,
          },
          {
            box: forbidden,
            url: vault.url,
            env: "development",
            message: `The stored key for ${vault.url} lacks the ${permission} permission for my-app/development, or is not scoped to it. Run jv login to get a key with ${permission}.`,
          },
          { box, url: vault.url, env: "missing", message: missingMessage },
          ...servers.map(({ status, server }) => {
            const url = `http://127.0.0.1:${server.port}`;
            return {
              box,
              url,
              env: "development",
              message:
                status === 409
                  ? `${command === "ls" ? "" : "FOO in "}my-app/development was changed by someone else. Run the command again.`
                  : `The vault at ${url} returned an unexpected response (${status}).`,
            };
          }),
        ];
        if (command !== "ls" && command !== "set") {
          cases.push({
            box,
            url: vault.url,
            env: "empty",
            message: keyMissingMessage("empty"),
          });
        }
        await Promise.all(
          cases.map(async (entry) => {
            await expectOutput(
              invoke(entry.box, [
                ...argsFor(command),
                "--project",
                "my-app",
                "--env",
                entry.env,
                "--url",
                entry.url,
              ]),
              {
                exitCode: 1,
                stdout: "",
                stderr: `${entry.message}\n`,
              }
            );
          })
        );
      })
    );
  } finally {
    await Promise.all(servers.map(({ server }) => server.stop(true)));
  }
}, 30_000);

test("input and usage errors send no requests and never repeat values", async () => {
  const box = await sandbox();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return new Response("unexpected", { status: 500 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  await store(box, url, "test-input-key");
  try {
    const invalidKey =
      "Invalid secret key. Use 1 to 255 uppercase letters, digits or underscores, starting with a letter or underscore.";
    const cases = [
      ...[
        "lower-case",
        "1BAD",
        "FOO\n",
        "A".repeat(256),
        "argument-secret",
      ].flatMap((key) =>
        ["get", "set", "rm", "history"].map((command) => ({
          args: [command, key, ...(command === "set" ? ["value"] : [])],
          input: undefined,
          message: invalidKey,
        }))
      ),
      {
        args: ["set", "FOO", "x".repeat(65_537)],
        message: "The value is larger than 64 KiB.",
      },
      {
        args: ["set", "FOO", "-"],
        input: "界".repeat(21_846),
        message: "The value is larger than 64 KiB.",
      },
      {
        args: ["set", "FOO", "-"],
        input: new Uint8Array([0xc3, 0x28]),
        message: "The value is not valid UTF-8 text.",
      },
      {
        args: ["set", "FOO"],
        message:
          "No value given and stdin is not a terminal. Pass a value, or - to read it from stdin.",
      },
    ];
    await Promise.all(
      cases.map(async (entry) => {
        const result = await invoke(
          box,
          [...entry.args, ...target, "--url", url],
          entry.input
        );
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe("");
        expect(stderr(result)).toBe(`${entry.message}\n`);
      })
    );
    const usageCases = commands.flatMap((command) => [
      [...argsFor(command), "--"],
      [...argsFor(command), "--no-browser"],
      [...argsFor(command), "extra", "extra"],
      [...argsFor(command), "--help", "--"],
      [...argsFor(command), "--help", "--no-browser"],
      [...argsFor(command), "extra", "extra", "--help"],
      ...(command === "ls" ? [[command, "FOO"]] : [[command]]),
    ]);
    usageCases.push(["set", "FOO", "-value"]);
    await Promise.all(
      usageCases.map(async (args) => {
        const result = await invoke(box, [...args, ...target, "--url", url]);
        expect(result.exitCode).toBe(2);
        expect(stderr(result)).toStartWith("Usage: jv");
      })
    );
    await Promise.all(
      commands.map(async (command) => {
        const result = await invoke(box, [...argsFor(command), "--url", url]);
        expect(result.exitCode).toBe(2);
        expect(stderr(result)).toBe(
          "No project and environment. Run jv link <project> --env <env>, or pass --project and --env.\n"
        );
      })
    );
    const streaming = spawn(["set", "FOO", "-", ...target, "--url", url], box);
    streaming.process.stdin.write("x".repeat(65_537));
    await streaming.process.stdin.flush();
    await expectOutput(streaming.exited, {
      exitCode: 2,
      stdout: "",
      stderr: "The value is larger than 64 KiB.\n",
    });
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
  }
}, 20_000);

test("terminal get adds a newline and hidden input handles editing, empty entry and Ctrl-C", async () => {
  const box = await sandbox();
  box.env.NO_COLOR = "1";
  await authenticate(box);
  await Promise.all(
    [
      {
        key: "PROMPT",
        input: "typed-secret\r",
        exitCode: 0,
        value: "typed-secret",
        message: "Stored PROMPT",
      },
      {
        key: "EDITED",
        input: "abc\u007F界\u007FZ\r",
        exitCode: 0,
        value: "abZ",
        message: "Stored EDITED",
      },
      {
        key: "NO_ENTRY",
        input: "\r",
        exitCode: 1,
        value: undefined,
        message: "No value entered. Nothing stored.",
      },
      {
        key: "CANCELLED",
        input: "typed-secret\u0003",
        exitCode: 130,
        value: undefined,
        message: "Value for CANCELLED:",
      },
    ].map(async ({ key, input, exitCode, value, message }) => {
      const result = await runJvInTerminal(
        ["set", key, ...target, "--url", vault.url],
        { ...box, input }
      );
      expect(result.exitCode).toBe(exitCode);
      expect(result.output).toContain(`Value for ${key}: `);
      expect(result.output).toContain(message);
      for (const secret of [...keys, ...values]) {
        expect(result.output).not.toContain(secret);
      }
      const fetched = await run(box, ["get", key]);
      if (value === undefined) {
        expect(fetched.exitCode).toBe(1);
        expect(fetched.stdout).toBe("");
      } else {
        expect(fetched.exitCode).toBe(0);
        expect(fetched.stdout).toBe(value);
      }
    })
  );
  const terminal = await runJvInTerminal(
    ["get", "PROMPT", ...target, "--url", vault.url],
    box
  );
  expect(terminal.exitCode).toBe(0);
  expect(terminal.output).toBe(
    `${warning.replaceAll("\n", "\r\n")}typed-secret\r\n`
  );
}, 20_000);

test.each([
  ["--help"],
  ["help"],
  ...commands.map((command) => [command, "--help"]),
])("help documents all commands and unchanged stdin: %j", async (...args) => {
  const box = await sandbox();
  const result = await runJv(args, box);
  expect(result.exitCode).toBe(0);
  for (const command of commands) {
    expect(result.stdout).toContain(`jv ${command}`);
  }
  expect(result.stdout).toContain(
    "- stores stdin unchanged, including a trailing newline"
  );
  expect(result.stdout).toContain("printf '%s'");
  noLeaks(result);
});
