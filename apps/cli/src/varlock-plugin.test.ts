import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import pathModule from "node:path";
import { fileURLToPath } from "node:url";

import { auditEvent, environment } from "@jomans-vault/db/schema/vault";
import { and, count, eq } from "drizzle-orm";

import { secretValues, startExportFixture } from "./test/export-fixture";
import { createSandbox, runJv, spawnJv } from "./test/harness";
import type { JvResult, Sandbox } from "./test/harness";

let fixture: Awaited<ReturnType<typeof startExportFixture>>;
const boxes: Sandbox[] = [];
const sourcePath = fileURLToPath(new URL("varlock-plugin.ts", import.meta.url));
const pluginPath = fileURLToPath(
  new URL("../dist/varlock-plugin.mjs", import.meta.url)
);
const varlockPath = fileURLToPath(
  new URL("../../../node_modules/.bin/varlock", import.meta.url)
);
const binaryDir = fileURLToPath(new URL("../dist", import.meta.url));
const nodePath = Bun.which("node");
if (!nodePath) {
  throw new Error("Plugin integration tests require Node on PATH");
}
const sandbox = async () => {
  const box = await createSandbox();
  boxes.push(box);
  const cwd = box.env.HOME ?? "";
  box.env.PATH = `${binaryDir}:${pathModule.dirname(nodePath)}:/usr/bin:/bin`;
  box.env.VARLOCK_TELEMETRY_DISABLED = "1";
  return { ...box, cwd };
};
type PluginSandbox = Awaited<ReturnType<typeof sandbox>>;
const schema = async (
  box: PluginSandbox,
  items = "FOO=jv()\nBAR=jv()\nLOCAL=jv(FOO)\n",
  init = "# @initJv(project=my-app, env=development)\n",
  pluginFile = pluginPath
) => {
  const path = pathModule.join(box.cwd, ".env.schema");
  await writeFile(
    path,
    `# @plugin(${pathModule.relative(box.cwd, pluginFile)})\n${init}# ---\n${items}`
  );
  return path;
};
const load = async (
  box: PluginSandbox,
  args = ["--format", "json"],
  runtime = nodePath,
  cwd = box.cwd
): Promise<JvResult> => {
  const child = Bun.spawn(
    [runtime, varlockPath, "load", "--path", box.cwd, ...args],
    {
      env: box.env,
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const exitCode = await child.exited;
  return { exitCode, stdout: await output, stderr: await errors };
};
const exportCount = async () => {
  const [row] = await fixture.vault.db
    .select({ total: count() })
    .from(auditEvent)
    .innerJoin(environment, eq(auditEvent.environmentId, environment.id))
    .where(
      and(
        eq(auditEvent.action, "secret.export"),
        eq(environment.slug, "development")
      )
    );
  return row?.total ?? 0;
};

beforeAll(async () => {
  fixture = await startExportFixture();
}, 30_000);
afterEach(async () => {
  await Promise.all(boxes.splice(0).map((box) => box.remove()));
});
afterAll(async () => {
  await fixture?.vault.stop();
});

test.each(["Node", "Bun"])(
  "loads the local plugin under %s, reuses login and exports once per load",
  async (runtime) => {
    const box = await sandbox();
    await fixture.authenticate(box);
    await schema(
      box,
      undefined,
      undefined,
      runtime === "Bun" ? sourcePath : pluginPath
    );
    const before = await exportCount();
    const output = await load(
      box,
      undefined,
      runtime === "Node" ? nodePath : process.execPath
    );
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({
      FOO: secretValues.FOO,
      BAR: secretValues.BAR,
      LOCAL: secretValues.FOO,
    });
    fixture.noLeaks(output, true);
    expect(await exportCount()).toBe(before + 1);
    // A second process must export again, rather than use an on-disk value cache.
    const again = await load(
      box,
      undefined,
      runtime === "Node" ? nodePath : process.execPath
    );
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual(JSON.parse(output.stdout));
    fixture.noLeaks(again, true);
    expect(await exportCount()).toBe(before + 2);
    const files = await readdir(box.cwd, {
      recursive: true,
      withFileTypes: true,
    });
    await Promise.all(
      files
        .filter((file) => file.isFile())
        .map(async (file) => {
          const content = await readFile(
            pathModule.join(file.parentPath, file.name),
            "utf-8"
          );
          fixture.noLeaks({ exitCode: 0, stdout: content, stderr: "" });
        })
    );
  },
  15_000
);

test.each(["development", "staging"])(
  "resolves project and env references through Varlock for %s",
  async (env) => {
    const box = await sandbox();
    await fixture.authenticate(box);
    await schema(
      box,
      "PROJECT=\nNODE_ENV=\nFOO=jv()\n",
      "# @initJv(project=$PROJECT, env=$NODE_ENV)\n"
    );
    box.env.PROJECT = "my-app";
    box.env.NODE_ENV = env;
    const output = await load(box);
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout).FOO).toBe(
      env === "development" ? secretValues.FOO : "private-staging-foo"
    );
    fixture.noLeaks(output, true);
  }
);

test("uses the init schema's directory and Varlock's environment for URL lookup", async () => {
  const box = await sandbox();
  await fixture.authenticate(box);
  const result = await runJv(
    ["link", "my-app", "--env", "staging", "--url", fixture.vault.url],
    box
  );
  expect(result.exitCode).toBe(0);
  await schema(box, "FOO=jv()\n");
  // Last-login is deliberately unusable: only the schema-local jv.json locates the vault.
  await writeFile(
    pathModule.join(box.env.XDG_CONFIG_HOME ?? "", "jv/config.json"),
    JSON.stringify({ url: "http://127.0.0.1:1" })
  );
  const output = await load(box, undefined, nodePath, box.env.XDG_CONFIG_HOME);
  expect(output.exitCode).toBe(0);
  expect(JSON.parse(output.stdout).FOO).toBe(secretValues.FOO);
  fixture.noLeaks(output, true);
  // JV_URL takes precedence over that same link.
  box.env.JV_URL = fixture.vault.url;
  await writeFile(
    pathModule.join(box.cwd, "jv.json"),
    JSON.stringify({
      project: "my-app",
      env: "development",
      url: "http://127.0.0.1:1",
    })
  );
  const byEnv = await load(box);
  expect(byEnv.exitCode).toBe(0);
  fixture.noLeaks(byEnv, true);
});

test.each([
  {
    name: "missing key",
    permissions: ["read", "inject"],
    items: "MISSING=jv()\n",
    missingBinary: false,
    message:
      "MISSING is not in my-app/development. Add it with jv set MISSING.",
  },
  {
    name: "no inject permission",
    permissions: ["read"],
    items: "FOO=jv()\n",
    missingBinary: false,
    message: "inject permission",
  },
  {
    name: "no stored credential",
    permissions: null,
    items: "FOO=jv()\n",
    missingBinary: false,
    message: "Run jv login",
  },
  {
    name: "jv missing from PATH",
    permissions: ["read", "inject"],
    items: "FOO=jv()\n",
    missingBinary: true,
    message: "Could not run jv. Install the jv CLI and put it on PATH.",
  },
])(
  "resolution failure: $name",
  async ({ permissions, items, missingBinary, message }) => {
    const box = await sandbox();
    if (permissions) {
      await fixture.authenticate(box, permissions);
    }
    await schema(box, items);
    box.env.JV_URL = fixture.vault.url;
    if (missingBinary) {
      box.env.PATH = "/usr/bin:/bin";
    }
    const output = await load(box);
    expect(output.exitCode).not.toBe(0);
    expect(output.stderr).toContain(message);
    fixture.noLeaks(output);
  }
);

test("explicit and implied sensitive items are redacted from default output", async () => {
  const box = await sandbox();
  await fixture.authenticate(box);
  await schema(box, "# @sensitive\nFOO=jv()\nBAR=jv()\n");
  const output = await load(box, []);
  expect(output.exitCode).toBe(0);
  expect(output.stdout).toContain("FOO");
  expect(output.stdout).toContain("BAR");
  fixture.noLeaks(output);
});

test("preserves a trailing newline stored through jv set stdin", async () => {
  const box = await sandbox();
  await fixture.authenticate(box, ["read", "write", "inject"]);
  const child = spawnJv(
    ["set", "PEM", "-", "--project", "my-app", "--env", "development"],
    box
  );
  child.process.stdin.write("x\n");
  child.process.stdin.end();
  const stored = await child.exited;
  expect(stored.exitCode).toBe(0);
  fixture.noLeaks(stored);
  await schema(box, "PEM=jv()\n");
  const output = await load(box);
  expect(output.exitCode).toBe(0);
  expect(JSON.parse(output.stdout)).toEqual({ PEM: "x\n" });
  fixture.noLeaks(output, true);
});

test.each([
  {
    init: "",
    items: "FOO=jv()\n",
    message: "jv() needs @initJv(project=..., env=...) in the schema header.",
  },
  {
    init: "# @initJv(env=development)\n",
    items: "FOO=jv()\n",
    message: "@initJv needs project and env.",
  },
  {
    init: "# @initJv(project=my-app)\n",
    items: "FOO=jv()\n",
    message: "@initJv needs project and env.",
  },
  {
    init: "# @initJv(project=my-app, env=development)\n# @initJv(project=my-app, env=staging)\n",
    items: "FOO=jv()\n",
    message: "Use @initJv only once",
  },
  {
    init: "# @initJv(project=my-app, env=development)\n",
    items: "FOO=jv(FOO, BAR)\n",
    message: "jv(): expects at most 1 argument",
  },
  {
    init: "# @initJv(project=my-app, env=development)\n",
    items: "FOO=jv(name=FOO)\n",
    message: "jv(): Resolver does not support key-value args",
  },
  {
    init: "# @initJv(project=my-app, env=development)\n",
    items: "NAME=FOO\nFOO=jv($NAME)\n",
    message: "jv() expects a static string key.",
  },
])("schema validation: $message ($items)", async ({ init, items, message }) => {
  const box = await sandbox();
  await schema(box, items, init);
  const output = await load(box);
  expect(output.exitCode).not.toBe(0);
  expect(output.stderr).toContain(message);
  fixture.noLeaks(output);
});

test.each([
  "not JSON",
  "null",
  "[]",
  '{"FOO":42}',
  '{"FOO":{"value":"private-export-foo"}}',
])(
  "malformed export output gives a fixed error without quoting stdout: %s",
  async (stdout) => {
    const box = await sandbox();
    const bin = pathModule.join(box.cwd, "bin");
    await mkdir(bin);
    await symlink(process.execPath, pathModule.join(bin, "bun"));
    const fake = pathModule.join(bin, "jv");
    await writeFile(
      fake,
      `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(stdout)});\n`
    );
    await chmod(fake, 0o700);
    box.env.PATH = bin;
    await schema(box, "FOO=jv()\n");
    const output = await load(box);
    expect(output.exitCode).not.toBe(0);
    expect(output.stderr).toContain(
      "jv export returned an unexpected response."
    );
    expect(output.stderr).not.toContain(stdout);
    fixture.noLeaks(output);
  }
);

test.each(["  an actionable jv error\n", ""])(
  "forwards trimmed failure stderr or supplies the exit code: %j",
  async (stderr) => {
    const box = await sandbox();
    const bin = pathModule.join(box.cwd, "bin");
    await mkdir(bin);
    await symlink(process.execPath, pathModule.join(bin, "bun"));
    box.env.PATH = bin;
    await schema(box, "FOO=jv()\n");
    const fake = pathModule.join(bin, "jv");
    await writeFile(
      fake,
      `#!/usr/bin/env bun\nprocess.stdout.write("private-export-foo");\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(7);\n`
    );
    await chmod(fake, 0o700);
    const output = await load(box);
    expect(output.exitCode).not.toBe(0);
    expect(output.stderr).toContain(
      stderr.trim() || "jv export failed (exit 7)."
    );
    fixture.noLeaks(output);
  }
);

test("the plugin is self-contained and uses only Node built-ins and Varlock's plugin API", async () => {
  const source = await readFile(sourcePath, "utf-8");
  const imports = [...source.matchAll(/from "(?<specifier>[^"]+)"/gu)];
  expect(imports.length).toBeGreaterThan(0);
  for (const match of imports) {
    const specifier = match.groups?.specifier ?? "";
    expect(
      specifier === "varlock/plugin-lib" || specifier.startsWith("node:")
    ).toBe(true);
  }
  expect(source).not.toContain("Bun.");
  expect(source).not.toContain("plugin.cache");
});
