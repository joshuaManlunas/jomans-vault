import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import pathModule from "node:path";

import { secretValues, startExportFixture } from "./test/export-fixture";
import { createSandbox, runJv } from "./test/harness";
import type { Sandbox } from "./test/harness";

let fixture: Awaited<ReturnType<typeof startExportFixture>>;
const boxes: Sandbox[] = [];
const sandbox = async () => {
  const box = await createSandbox();
  boxes.push(box);
  return { ...box, cwd: box.env.HOME };
};
const flags = ["--project", "my-app", "--env", "development"];

beforeAll(async () => {
  fixture = await startExportFixture();
}, 30_000);
afterEach(async () => {
  await Promise.all(boxes.splice(0).map((box) => box.remove()));
});
afterAll(async () => {
  await fixture?.vault.stop();
});

test("export prints one JSON object plus a newline, including empty environments", async () => {
  const box = await sandbox();
  await fixture.authenticate(box);
  const output = await runJv(["export", ...flags], box);
  expect(output.exitCode).toBe(0);
  expect(output.stdout).toBe(
    `${JSON.stringify({ BAR: secretValues.BAR, FOO: secretValues.FOO, PEM: secretValues.PEM })}\n`
  );
  fixture.noLeaks(output, true);
  const empty = await runJv(["export", ...flags, "--env", "empty"], box);
  expect(empty.exitCode).toBe(0);
  expect(empty.stdout).toBe("{}\n");
  fixture.noLeaks(empty);
});

test("export reuses linked slugs, nearest directory, URL lookup and explicit overrides", async () => {
  const box = await sandbox();
  await fixture.authenticate(box);
  const link = await runJv(
    ["link", "my-app", "--env", "staging", "--url", fixture.vault.url],
    box
  );
  expect(link.exitCode).toBe(0);
  const nested = pathModule.join(box.cwd ?? "", "nested");
  await mkdir(nested);
  const linked = await runJv(["export"], { ...box, cwd: nested });
  expect(linked.exitCode).toBe(0);
  expect(JSON.parse(linked.stdout)).toEqual({ FOO: "private-staging-foo" });
  fixture.noLeaks(linked, true);
  const overridden = await runJv(
    ["export", ...flags, "--url", fixture.vault.url],
    { ...box, cwd: nested }
  );
  expect(overridden.exitCode).toBe(0);
  expect(JSON.parse(overridden.stdout)).toEqual(secretValues);
  fixture.noLeaks(overridden, true);
  const byEnv = await runJv(["export", ...flags], {
    ...box,
    env: { ...box.env, JV_URL: fixture.vault.url },
  });
  expect(byEnv.exitCode).toBe(0);
  expect(JSON.parse(byEnv.stdout)).toEqual(secretValues);
  fixture.noLeaks(byEnv, true);
});

test.each([
  { permissions: null, message: "Run jv login" },
  { permissions: ["read"], message: "inject permission" },
])(
  "export fails without values: $message",
  async ({ permissions, message }) => {
    const box = await sandbox();
    if (permissions) {
      await fixture.authenticate(box, permissions);
    }
    const output = await runJv(
      ["export", ...flags, "--url", fixture.vault.url],
      box
    );
    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain(message);
    fixture.noLeaks(output);
  }
);

test.each(
  [
    ["export", "extra"],
    ["export", "--"],
    ["export", "--", "ignored"],
    ["export", "--no-browser"],
    ["export", "--no-browser", "--help"],
  ].map((args) => ({ args }))
)("export rejects invalid usage: $args", async ({ args }) => {
  const box = await sandbox();
  const output = await runJv(args, box);
  expect(output.exitCode).toBe(2);
  expect(output.stdout).toBe("");
  expect(output.stderr).toContain("Usage: jv");
  fixture.noLeaks(output);
});

test("export requires project and environment and documents itself in help", async () => {
  const box = await sandbox();
  const missing = await runJv(["export"], box);
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr).toContain("No project and environment.");
  expect(missing.stdout).toBe("");
  await Promise.all(
    [["help"], ["export", "--help"]].map(async (args) => {
      const output = await runJv(args, box);
      expect(output.exitCode).toBe(0);
      expect(output.stdout).toContain(
        "jv export [--project <p>] [--env <e>] [--url <u>]"
      );
      expect(output.stdout).toContain("Print an environment's values as JSON");
      fixture.noLeaks(output);
    })
  );
});

test("export rejects unexpected vault output without leaking response values", async () => {
  const box = await sandbox();
  const key = await fixture.authenticate(box);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ FOO: { value: secretValues.FOO } }),
  });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    await writeFile(
      pathModule.join(box.env.JV_TEST_KEYCHAIN ?? "", "keychain.json"),
      JSON.stringify({ jv: { [url]: key } })
    );
    const output = await runJv(["export", ...flags, "--url", url], box);
    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("returned an unexpected response (200).");
    fixture.noLeaks(output);
  } finally {
    await server.stop(true);
  }
});
