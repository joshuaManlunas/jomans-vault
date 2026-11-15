import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { scripts } from "../package.json";

let fixture: string;
const fileKey = btoa(
  String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))
);
const shellKey = btoa(
  String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))
);

beforeAll(async () => {
  await mkdir(".turbo", { recursive: true });
  fixture = await mkdtemp(path.join(process.cwd(), ".turbo/compose-env-"));
  await mkdir(path.join(fixture, "apps/web"), { recursive: true });
  await copyFile(
    "docker-compose.yml",
    path.join(fixture, "docker-compose.yml")
  );
  await writeFile(
    path.join(fixture, "apps/web/.env"),
    `VAULT_MASTER_KEY=${fileKey}\n`
  );
});

afterAll(async () => {
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
  }
});

test.each(
  (["docker:build", "docker:up"] as const).flatMap((script) => [
    { script, name: "app env file", override: undefined, expected: fileKey },
    { script, name: "host override", override: shellKey, expected: shellKey },
  ])
)(
  "$script preserves the master key from $name",
  ({ script, override, expected }) => {
    const env = { ...process.env };
    delete env.VAULT_MASTER_KEY;
    delete env.COMPOSE_FILE;
    delete env.COMPOSE_ENV_FILES;
    if (override) {
      env.VAULT_MASTER_KEY = override;
    }
    const command = scripts[script].split(" ");
    const operation = script === "docker:build" ? "build" : "up";
    const result = Bun.spawnSync(
      [
        ...command.slice(0, command.indexOf(operation)),
        "config",
        "--format",
        "json",
        "web",
      ],
      { cwd: fixture, env }
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      services: { web: { environment: { VAULT_MASTER_KEY: expected } } },
    });
  }
);
