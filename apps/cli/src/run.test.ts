import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  link as hardlink,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import pathModule from "node:path";

import { loginRequest } from "@jomans-vault/db/schema/vault";
import { eq } from "drizzle-orm";

import {
  approvalPairingCode,
  approvalRequestId,
  createSandbox,
  runJv,
  spawnJv,
  startVault,
} from "./test/harness";
import type { JvResult, Sandbox, Vault } from "./test/harness";

let vault: Vault;
let cookie: string;
const boxes: Sandbox[] = [];
const children: ReturnType<typeof spawnJv>[] = [];
const keys = new Set<string>();
const credentialIds = new Map<string, string>();
const secretValues = [
  "from-vault",
  "staging-value",
  "other-value",
  "private-bar-value",
];
const scope = {
  projects: {
    "my-app": ["development", "staging"],
    "other-app": ["development"],
  },
};

const sandbox = async () => {
  const box = await createSandbox();
  boxes.push(box);
  const cwd = await realpath(box.env.HOME ?? "");
  return { ...box, cwd };
};
const spawn = (args: string[], box: Sandbox & { cwd: string }) => {
  const child = spawnJv(args, box);
  children.push(child);
  return child;
};
const noLeaks = (output: JvResult, childRan = false) => {
  for (const value of [...keys, ...secretValues]) {
    expect(output.stderr).not.toContain(value);
    if (!childRan) {
      expect(output.stdout).not.toContain(value);
    }
  }
};
const authenticate = async (
  box: Sandbox & { cwd: string },
  permissions = ["read", "inject"],
  keyScope: { projects: Record<string, string[]> } = scope
) => {
  const child = spawn(["login", "--no-browser", "--url", vault.url], box);
  const id = approvalRequestId(await child.waitForStderr(/Open this link/u));
  const pairingCode = approvalPairingCode(
    await child.waitForStderr(/Enter this pairing code/u)
  );
  const approved = await vault.api("POST", `/login-requests/${id}/approve`, {
    cookie,
    body: { scope: keyScope, permissions, pairingCode },
  });
  expect(approved.status).toBe(200);
  const output = await child.waitForExit();
  expect(output.exitCode).toBe(0);
  const entries = await box.keychain();
  const key = entries.jv?.[vault.url];
  if (!key) {
    throw new Error("Expected a stored key");
  }
  keys.add(key);
  const [row] = await vault.db
    .select()
    .from(loginRequest)
    .where(eq(loginRequest.id, id));
  if (!row?.apiKeyId) {
    throw new Error("Expected the login request to reference its key");
  }
  credentialIds.set(key, row.apiKeyId);
  noLeaks(output);
  return key;
};
const link = async (
  box: Sandbox & { cwd: string },
  project = "my-app",
  environment = "development",
  extra: string[] = []
) => {
  const output = await runJv(
    ["link", project, "--env", environment, ...extra],
    box
  );
  expect(output.exitCode).toBe(0);
  noLeaks(output);
  return output;
};
const expectStatus = async (pending: Promise<Response>, status: number) => {
  const response = await pending;
  expect(response.status).toBe(status);
};
const printFoo = [process.execPath, "-e", "console.log(process.env.FOO)"];
const runArgs = (...command: string[]) => ["run", "--", ...command];
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
const snapshot = async (dir: string): Promise<unknown[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const path = pathModule.join(dir, entry.name);
        if (entry.isDirectory()) {
          return await snapshot(path);
        }
        const info = await stat(path);
        return [
          { path, size: info.size, content: await readFile(path, "base64") },
        ];
      })
  );
  return files.flat();
};

beforeAll(async () => {
  vault = await startVault();
  ({ cookie } = await vault.signup("run-owner@example.com"));
  await Promise.all(
    ["my-app", "other-app"].map(async (project) => {
      await expectStatus(
        vault.api("POST", "/projects", {
          cookie,
          body: { slug: project, name: project },
        }),
        201
      );
      const environments =
        project === "my-app"
          ? ["development", "staging", "removed"]
          : ["development"];
      await Promise.all(
        environments.map(async (environment) => {
          await expectStatus(
            vault.api("POST", `/projects/${project}/envs`, {
              cookie,
              body: { slug: environment },
            }),
            201
          );
          let value = "from-vault";
          if (project === "other-app") {
            value = "other-value";
          } else if (environment === "staging") {
            value = "staging-value";
          }
          await expectStatus(
            vault.api(
              "PUT",
              `/projects/${project}/envs/${environment}/secrets/FOO`,
              { cookie, body: { value } }
            ),
            200
          );
        })
      );
    })
  );
  await expectStatus(
    vault.api("PUT", "/projects/my-app/envs/development/secrets/BAR", {
      cookie,
      body: { value: "private-bar-value" },
    }),
    200
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

test("link writes only slugs and an explicit normalized URL, replaces locally and ignores parent links", async () => {
  const box = await sandbox();
  box.env.JV_URL = "ftp://ignored";
  const output = await link(box);
  const path = pathModule.join(box.cwd, "jv.json");
  expect(await readFile(path, "utf-8")).toBe(
    '{\n  "project": "my-app",\n  "env": "development"\n}\n'
  );
  expect(output.stderr).toContain(`Linked ${box.cwd} to my-app/development.`);
  const withUrl = await link(box, "other-app", "staging", [
    "--url",
    `${vault.url}///?ignored=1#hash`,
  ]);
  expect(await Bun.file(path).json()).toEqual({
    project: "other-app",
    env: "staging",
    url: vault.url,
  });
  expect(withUrl.stderr).toContain(` at ${vault.url}.`);
  await writeFile(path, "{");
  const nested = pathModule.join(box.cwd, "nested");
  await mkdir(nested);
  await link({ ...box, cwd: nested });
  expect(await Bun.file(pathModule.join(nested, "jv.json")).json()).toEqual({
    project: "my-app",
    env: "development",
  });
  expect(await readFile(path, "utf-8")).toBe("{");
  expect(await box.keychain()).toEqual({});
  expect(
    await Bun.file(
      pathModule.join(box.env.XDG_CONFIG_HOME ?? "", "jv/config.json")
    ).exists()
  ).toBe(false);
});

test.each(["symlink", "dangling symlink", "hardlink"])(
  "link replaces a %s without changing its target",
  async (kind) => {
    const box = await sandbox();
    const target = pathModule.join(pathModule.dirname(box.cwd), "target.json");
    const path = pathModule.join(box.cwd, "jv.json");
    if (kind !== "dangling symlink") {
      await writeFile(target, "outside file stays unchanged\n");
    }
    await (kind === "hardlink"
      ? hardlink(target, path)
      : symlink(pathModule.relative(box.cwd, target), path));

    await link(box);

    const info = await lstat(path);
    expect(info.isFile()).toBe(true);
    expect(await Bun.file(path).json()).toEqual({
      project: "my-app",
      env: "development",
    });
    if (kind === "dangling symlink") {
      expect(await Bun.file(target).exists()).toBe(false);
    } else {
      expect(await readFile(target, "utf-8")).toBe(
        "outside file stays unchanged\n"
      );
    }
    expect(await readdir(box.cwd)).toEqual(["jv.json"]);
  }
);

test("link cleans up its temporary file when replacement fails", async () => {
  const box = await sandbox();
  const path = pathModule.join(box.cwd, "jv.json");
  await mkdir(path);
  const before = await snapshot(pathModule.dirname(box.cwd));

  const output = await runJv(["link", "my-app", "--env", "development"], box);

  expect(output.exitCode).toBe(1);
  noLeaks(output);
  const info = await lstat(path);
  expect(info.isDirectory()).toBe(true);
  expect(await readdir(box.cwd)).toEqual(["jv.json"]);
  expect(await snapshot(pathModule.dirname(box.cwd))).toEqual(before);
});

test.each(
  [
    ["link"],
    ["link", "my-app"],
    ["link", "--env", "development"],
    ["link", "My_App", "--env", "development"],
    ["link", "my-app", "--env", "development", "extra"],
    ["link", "my-app", "--env", "development", "--url", "ftp://x"],
    ["link", "my-app", "--env", "INVALID"],
    ["link", "a".repeat(65), "--env", "development"],
  ].map((args) => ({ args }))
)("link usage errors write nothing: $args", async ({ args }) => {
  const box = await sandbox();
  const before = await snapshot(pathModule.dirname(box.cwd));
  const output = await runJv(args, box);
  expect(output.exitCode).toBe(2);
  noLeaks(output);
  expect(output.stdout).toBe("");
  expect(await snapshot(pathModule.dirname(box.cwd))).toEqual(before);
});

test("nearest ancestor discovery, independent overrides, unlinked flags and environment overlay", async () => {
  const box = await sandbox();
  await authenticate(box);
  await link(box);
  const nested = pathModule.join(box.cwd, "nested/deeper");
  await mkdir(nested, { recursive: true });
  const cases = [
    { cwd: nested, flags: [], value: "from-vault" },
    { cwd: nested, flags: ["--env", "staging"], value: "staging-value" },
    { cwd: nested, flags: ["--project", "other-app"], value: "other-value" },
    {
      cwd: nested,
      flags: ["--project", "other-app", "--env", "development"],
      value: "other-value",
    },
    {
      cwd: box.env.XDG_CONFIG_HOME,
      flags: ["--project", "other-app", "--env", "development"],
      value: "other-value",
    },
  ];
  await Promise.all(
    cases.map(async ({ cwd, flags, value }) => {
      const output = await runJv(["run", ...flags, "--", ...printFoo], {
        env: box.env,
        cwd,
      });
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toBe(`${value}\n`);
      noLeaks(output, true);
    })
  );
  const output = await runJv(
    runArgs(
      process.execPath,
      "-e",
      "console.log(JSON.stringify([process.env.FOO,process.env.BAR,process.env.PARENT_ONLY,process.argv.slice(1)]))",
      "--",
      "--env",
      "child-value",
      "a b",
      "$literal"
    ),
    {
      cwd: nested,
      env: { ...box.env, FOO: "from-shell", PARENT_ONLY: "parent" },
    }
  );
  expect(output.exitCode).toBe(0);
  expect(JSON.parse(output.stdout)).toEqual([
    "from-vault",
    "private-bar-value",
    "parent",
    ["--env", "child-value", "a b", "$literal"],
  ]);
  noLeaks(output, true);
  await link({ ...box, cwd: pathModule.dirname(nested) }, "my-app", "staging");
  const nearest = await runJv(runArgs(...printFoo), {
    env: box.env,
    cwd: nested,
  });
  expect(nearest.stdout).toBe("staging-value\n");
  noLeaks(nearest, true);
}, 15_000);

test("URL precedence and normalization for both run and login (table driven)", async () => {
  const box = await sandbox();
  const key = await authenticate(box);
  const urls = await Promise.all(Array.from({ length: 4 }, () => closedUrl()));
  const [flag, env, linked, remembered] = urls;
  if (!(flag && env && linked && remembered)) {
    throw new Error("Expected four URLs");
  }
  await writeFile(
    pathModule.join(box.env.JV_TEST_KEYCHAIN ?? "", "keychain.json"),
    JSON.stringify({ jv: Object.fromEntries(urls.map((url) => [url, key])) })
  );
  const cases = [
    {
      flag: `${flag}///?ignored=1#hash`,
      env,
      linked,
      remembered,
      expected: flag,
    },
    { env, linked, remembered, expected: env },
    { env: "", linked, remembered, expected: linked },
    { remembered, expected: remembered },
  ];
  await Promise.all(
    cases.flatMap((entry) =>
      ["run", "login"].map(async (command) => {
        const dir = pathModule.join(box.cwd, crypto.randomUUID());
        await mkdir(dir);
        // Each command has its own config to keep the cases independent.
        const config = pathModule.join(dir, "config");
        await mkdir(pathModule.join(config, "jv"), { recursive: true });
        await writeFile(
          pathModule.join(config, "jv/config.json"),
          JSON.stringify({ url: entry.remembered })
        );
        if (entry.linked) {
          await link({ ...box, cwd: dir }, "my-app", "development", [
            "--url",
            entry.linked,
          ]);
        }
        const flags = entry.flag ? ["--url", entry.flag] : [];
        const args =
          command === "run"
            ? [
                "run",
                "--project",
                "my-app",
                "--env",
                "development",
                ...flags,
                "--",
                ...printFoo,
              ]
            : ["login", "--no-browser", ...flags];
        const output = await runJv(args, {
          cwd: dir,
          env: { ...box.env, XDG_CONFIG_HOME: config, JV_URL: entry.env },
        });
        expect(output.exitCode).toBe(1);
        expect(output.stderr).toContain(
          `Could not reach the vault at ${entry.expected}.`
        );
        noLeaks(output);
      })
    )
  );
}, 15_000);

test("run preserves child exit codes, all stdio, signal exit status and writes no files", async () => {
  const box = await sandbox();
  await authenticate(box);
  await link(box);
  const before = await snapshot(pathModule.dirname(box.cwd));
  const failed = await runJv(
    runArgs(process.execPath, "-e", "process.exit(7)"),
    box
  );
  expect(failed.exitCode).toBe(7);
  noLeaks(failed);
  const child = spawn(
    runArgs(
      process.execPath,
      "-e",
      'console.log(await Bun.stdin.text()); console.error("child-stderr")'
    ),
    box
  );
  child.process.stdin.write("stdin-text");
  child.process.stdin.end();
  const output = await child.waitForExit();
  expect(output.exitCode).toBe(0);
  expect(output.stdout).toBe("stdin-text\n");
  expect(output.stderr).toContain("child-stderr");
  noLeaks(output);
  const killed = await runJv(
    runArgs(process.execPath, "-e", 'process.kill(process.pid,"SIGKILL")'),
    box
  );
  expect(killed.exitCode).toBe(137);
  noLeaks(killed);
  expect(await snapshot(pathModule.dirname(box.cwd))).toEqual(before);
}, 15_000);

test.each([
  ["SIGTERM", 41],
  ["SIGINT", 42],
] as const)(
  "forwards %s to the child and waits for its exit",
  async (signal, code) => {
    const box = await sandbox();
    await authenticate(box);
    await link(box);
    const child = spawn(
      runArgs(
        process.execPath,
        "-e",
        `process.on("${signal}",()=>setTimeout(()=>process.exit(${code}),100)); setInterval(()=>{},1000); console.error("ready")`
      ),
      box
    );
    try {
      await child.waitForStderr(/^ready$/u);
      process.kill(child.process.pid, signal);
      const output = await child.waitForExit();
      expect(output.exitCode).toBe(code);
      noLeaks(output);
    } finally {
      child.process.stdin.end();
    }
  },
  15_000
);

test("failure matrix never starts the child, reports exact messages and leaks nothing", async () => {
  const box = await sandbox();
  const readOnly = await sandbox();
  const revoked = await sandbox();
  const missingKey = await sandbox();
  const [key, , revokedKey] = await Promise.all([
    authenticate(box, ["read", "inject"], {
      projects: {
        ...scope.projects,
        "my-app": ["development", "staging", "removed"],
      },
    }),
    authenticate(readOnly, ["read"]),
    authenticate(revoked),
  ]);
  await expectStatus(
    vault.api("POST", `/api-keys/${credentialIds.get(revokedKey)}/revoke`, {
      cookie,
    }),
    200
  );
  const closed = await closedUrl();
  const keychain = await box.keychain();
  await writeFile(
    pathModule.join(box.env.JV_TEST_KEYCHAIN ?? "", "keychain.json"),
    JSON.stringify({ jv: { ...keychain.jv, [closed]: key } })
  );
  await expectStatus(
    vault.api("DELETE", "/projects/my-app/envs/removed", { cookie }),
    204
  );
  const noScope = await sandbox();
  await authenticate(noScope, ["read", "inject"], {
    projects: { "my-app": ["development"] },
  });
  const flags = [
    "--project",
    "my-app",
    "--env",
    "development",
    "--url",
    vault.url,
  ];
  const forbidden = (project: string, environment: string) =>
    `The stored key for ${vault.url} cannot inject ${project}/${environment}: it lacks the inject permission or is not scoped to it. Run jv login to get a key for it.`;
  const cases = [
    {
      box,
      args: [],
      code: 2,
      message:
        "No project and environment. Run jv link <project> --env <env>, or pass --project and --env.",
    },
    {
      box,
      args: ["--project", "my-app"],
      code: 2,
      message:
        "No project and environment. Run jv link <project> --env <env>, or pass --project and --env.",
    },
    {
      box,
      args: ["--env", "development"],
      code: 2,
      message:
        "No project and environment. Run jv link <project> --env <env>, or pass --project and --env.",
    },
    { box, args: flags, separator: false, code: 2, message: "Usage:" },
    { box, args: flags, empty: true, code: 2, message: "Usage:" },
    {
      box: missingKey,
      args: flags,
      code: 1,
      message: `Not logged in to ${vault.url}. Run jv login.`,
    },
    {
      box,
      args: ["--project", "my-app", "--env", "development", "--url", closed],
      code: 1,
      message: `Could not reach the vault at ${closed}.`,
    },
    {
      box: revoked,
      args: flags,
      code: 1,
      message: `The vault at ${vault.url} rejected the stored key. Run jv login again.`,
    },
    {
      box: readOnly,
      args: flags,
      code: 1,
      message: forbidden("my-app", "development"),
    },
    {
      box: noScope,
      args: [
        "--project",
        "other-app",
        "--env",
        "development",
        "--url",
        vault.url,
      ],
      code: 1,
      message: forbidden("other-app", "development"),
    },
    {
      box: noScope,
      args: ["--project", "my-app", "--env", "staging", "--url", vault.url],
      code: 1,
      message: forbidden("my-app", "staging"),
    },
    {
      box,
      args: ["--project", "my-app", "--env", "removed", "--url", vault.url],
      code: 1,
      message: `Project my-app or environment removed not found at ${vault.url}.`,
    },
    {
      box,
      args: flags,
      missing: true,
      code: 127,
      message: "Could not start jv-nonexistent-command.",
    },
    {
      box: missingKey,
      args: ["--project", "my-app", "--env", "development"],
      code: 2,
      message:
        "No vault URL. Pass --url <url>, set JV_URL, or log in once with --url.",
    },
    {
      box,
      args: ["--project", "INVALID", "--env", "development"],
      code: 2,
      message: "Invalid project or environment:",
    },
    {
      box,
      args: ["--project", "my-app", "--env", "INVALID"],
      code: 2,
      message: "Invalid project or environment:",
    },
  ];
  await Promise.all(
    cases.map(async (entry) => {
      const marker = pathModule.join(entry.box.cwd, crypto.randomUUID());
      const command = entry.missing
        ? ["jv-nonexistent-command"]
        : [
            process.execPath,
            "-e",
            `await Bun.write(${JSON.stringify(marker)}, "started")`,
          ];
      const args = [
        "run",
        ...entry.args,
        ...(entry.separator === false
          ? command
          : ["--", ...(entry.empty ? [] : command)]),
      ];
      const output = await runJv(args, entry.box);
      expect(output.exitCode).toBe(entry.code);
      expect(output.stderr).toContain(entry.message);
      expect(output.stdout).toBe("");
      expect(await Bun.file(marker).exists()).toBe(false);
      noLeaks(output);
    })
  );
}, 30_000);

test.each([
  "{",
  "[]",
  '{"project":"my-app"}',
  "null",
  '{"project":"INVALID","env":"dev"}',
  '{"project":"my-app","env":"dev","url":3}',
])(
  "malformed nearest jv.json fails before any child or network: %s",
  async (contents) => {
    const box = await sandbox();
    const path = pathModule.join(box.cwd, "jv.json");
    await writeFile(path, contents);
    await Promise.all(
      ["run", "login"].map(async (command) => {
        const marker = pathModule.join(box.cwd, command);
        const args = [
          command,
          "--project",
          "my-app",
          "--env",
          "development",
          "--url",
          vault.url,
        ];
        if (command === "run") {
          args.push(
            "--",
            process.execPath,
            "-e",
            `await Bun.write(${JSON.stringify(marker)}, "started")`
          );
        }
        const output = await runJv(args, box);
        expect(output.exitCode).toBe(2);
        expect(output.stderr).toContain(
          `Invalid jv.json at ${path}: expected {"project": "<slug>", "env": "<slug>"} with an optional "url".`
        );
        expect(await Bun.file(marker).exists()).toBe(false);
        noLeaks(output);
      })
    );
  }
);

test("a linked non-http URL fails even when flags override it; unknown link keys are ignored", async () => {
  const box = await sandbox();
  await writeFile(
    pathModule.join(box.cwd, "jv.json"),
    JSON.stringify({ project: "my-app", env: "development", url: "ftp://x" })
  );
  const invalid = await runJv(
    ["run", "--url", vault.url, "--", ...printFoo],
    box
  );
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr).toContain(
    'Invalid vault URL "ftp://x": use an http:// or https:// URL.'
  );
  noLeaks(invalid);
  await authenticate({ ...box, cwd: box.env.XDG_CONFIG_HOME ?? "" });
  await writeFile(
    pathModule.join(box.cwd, "jv.json"),
    JSON.stringify({ project: "my-app", env: "development", extra: "ignored" })
  );
  const output = await runJv(runArgs(...printFoo), box);
  expect(output.exitCode).toBe(0);
  expect(output.stdout).toBe("from-vault\n");
  noLeaks(output, true);
}, 15_000);

test("vault B never receives a key stored for vault A", async () => {
  const box = await sandbox();
  await authenticate(box);
  const other = await startVault();
  try {
    await link(box, "my-app", "development", ["--url", other.url]);
    const output = await runJv(runArgs(...printFoo), box);
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain(
      `Not logged in to ${other.url}. Run jv login.`
    );
    noLeaks(output);
  } finally {
    await other.stop();
  }
}, 15_000);

test("unexpected statuses, malformed JSON and non-string maps never start a child or echo response bodies", async () => {
  const box = await sandbox();
  const key = await authenticate(box);
  await Promise.all(
    [
      { status: 500, body: "from-vault" },
      { status: 200, body: "not json from-vault" },
      { status: 200, body: JSON.stringify({ FOO: { value: "from-vault" } }) },
      { status: 200, body: JSON.stringify(["from-vault"]) },
      { status: 200, body: "null" },
    ].map(async ({ status, body }) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          expect(request.headers.get("x-api-key")).toBe(key);
          expect(new URL(request.url).pathname).toBe(
            "/api/v1/projects/my-app/envs/development/export"
          );
          return new Response(body, { status });
        },
      });
      const url = `http://127.0.0.1:${server.port}`;
      const dir = pathModule.join(box.cwd, crypto.randomUUID());
      await mkdir(pathModule.join(dir, "keychain"), { recursive: true });
      await writeFile(
        pathModule.join(dir, "keychain/keychain.json"),
        JSON.stringify({ jv: { [url]: key } })
      );
      const marker = pathModule.join(dir, "started");
      try {
        const output = await runJv(
          [
            "run",
            "--project",
            "my-app",
            "--env",
            "development",
            "--url",
            url,
            "--",
            process.execPath,
            "-e",
            `await Bun.write(${JSON.stringify(marker)}, "started")`,
          ],
          {
            cwd: dir,
            env: {
              ...box.env,
              JV_TEST_KEYCHAIN: pathModule.join(dir, "keychain"),
            },
          }
        );
        expect(output.exitCode).toBe(1);
        expect(output.stderr).toContain(
          `The vault at ${url} returned an unexpected response (${status}).`
        );
        expect(await Bun.file(marker).exists()).toBe(false);
        noLeaks(output);
      } finally {
        await server.stop(true);
      }
    })
  );
}, 15_000);

test("export headers and bodies time out after ten seconds without starting a child or leaking", async () => {
  const box = await sandbox();
  const key = await authenticate(box);
  await Promise.all(
    ["headers", "body"].map(async (phase) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        fetch: () =>
          phase === "body"
            ? new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode('{"FOO":"from-vault')
                    );
                  },
                })
              )
            : Promise.withResolvers<Response>().promise,
      });
      const url = `http://127.0.0.1:${server.port}`;
      const dir = pathModule.join(box.cwd, phase);
      await mkdir(pathModule.join(dir, "keychain"), { recursive: true });
      await writeFile(
        pathModule.join(dir, "keychain/keychain.json"),
        JSON.stringify({ jv: { [url]: key } })
      );
      const marker = pathModule.join(dir, "started");
      try {
        const started = Date.now();
        const output = await runJv(
          [
            "run",
            "--project",
            "my-app",
            "--env",
            "development",
            "--url",
            url,
            "--",
            process.execPath,
            "-e",
            `await Bun.write(${JSON.stringify(marker)}, "started")`,
          ],
          {
            cwd: dir,
            env: {
              ...box.env,
              JV_TEST_KEYCHAIN: pathModule.join(dir, "keychain"),
            },
          }
        );
        expect(output.exitCode).toBe(1);
        expect(Date.now() - started).toBeGreaterThanOrEqual(9900);
        expect(output.stderr).toContain(`Could not reach the vault at ${url}.`);
        expect(await Bun.file(marker).exists()).toBe(false);
        noLeaks(output);
      } finally {
        await server.stop(true);
      }
    })
  );
}, 25_000);

test("export redirects never forward a stored key to another server", async () => {
  const box = await sandbox();
  const key = await authenticate(box);
  let requests = 0;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return Response.json({ FOO: "from-vault" });
    },
  });
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.redirect(`http://127.0.0.1:${target.port}/export`),
  });
  const url = `http://127.0.0.1:${source.port}`;
  await writeFile(
    pathModule.join(box.env.JV_TEST_KEYCHAIN ?? "", "keychain.json"),
    JSON.stringify({ jv: { [url]: key } })
  );
  try {
    const output = await runJv(
      [
        "run",
        "--project",
        "my-app",
        "--env",
        "development",
        "--url",
        url,
        "--",
        ...printFoo,
      ],
      box
    );
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain(
      `The vault at ${url} returned an unexpected response (302).`
    );
    expect(requests).toBe(0);
    noLeaks(output);
  } finally {
    await Promise.all([target.stop(true), source.stop(true)]);
  }
}, 15_000);
