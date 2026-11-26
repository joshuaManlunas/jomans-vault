import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { scripts } from "../package.json";

let fixture: string;
let missingKeyFixture: string;
const fileKey = btoa(
  String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))
);
const shellKey = btoa(
  String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))
);

type ComposeScript =
  | "docker:build"
  | "docker:up"
  | "docker:up:prod"
  | "db:start";

const resolveConfig = (
  script: ComposeScript,
  service: "web" | "postgres",
  cwd = fixture,
  override?: string
) => {
  const env = { ...process.env };
  delete env.VAULT_MASTER_KEY;
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_ENV_FILES;
  delete env.COMPOSE_PROFILES;
  if (override !== undefined) {
    env.VAULT_MASTER_KEY = override;
  }
  const command = scripts[script].split(" ");
  const operation = script === "docker:build" ? "build" : "up";
  return Bun.spawnSync(
    [
      ...command.slice(0, command.indexOf(operation)),
      "config",
      "--format",
      "json",
      service,
    ],
    { cwd, env }
  );
};

beforeAll(async () => {
  await mkdir(".turbo", { recursive: true });
  fixture = await mkdtemp(path.join(process.cwd(), ".turbo/compose-env-"));
  missingKeyFixture = await mkdtemp(
    path.join(process.cwd(), ".turbo/compose-missing-key-")
  );
  await Promise.all(
    [fixture, missingKeyFixture].map(async (directory) => {
      await mkdir(path.join(directory, "apps/web"), { recursive: true });
      await Promise.all(
        [
          "docker-compose.yml",
          "docker-compose.key.yml",
          "docker-compose.prod.yml",
        ].map((file) => copyFile(file, path.join(directory, file)))
      );
    })
  );
  await writeFile(
    path.join(fixture, "apps/web/.env"),
    `VAULT_MASTER_KEY=${fileKey}\n`
  );
});

afterAll(async () => {
  await Promise.all(
    [fixture, missingKeyFixture]
      .filter(Boolean)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

test.each(
  (["docker:build", "docker:up", "docker:up:prod"] as const).flatMap(
    (script) => [
      { script, name: "app env file", override: undefined, expected: fileKey },
      { script, name: "host override", override: shellKey, expected: shellKey },
    ]
  )
)(
  "$script preserves the master key from $name",
  ({ script, override, expected }) => {
    const result = resolveConfig(script, "web", fixture, override);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      services: { web: { environment: { VAULT_MASTER_KEY: expected } } },
    });
  }
);

test("production removes Postgres host ports", () => {
  const result = resolveConfig("docker:up:prod", "postgres");
  expect(result.exitCode).toBe(0);
  const { postgres } = JSON.parse(result.stdout.toString()).services;
  expect(postgres.ports ?? []).toEqual([]);
});

test("local web keeps its all-interfaces port", () => {
  const result = resolveConfig("docker:up", "web");
  expect(result.exitCode).toBe(0);
  const { web } = JSON.parse(result.stdout.toString()).services;
  expect(web.ports).toEqual([
    { mode: "ingress", published: "3001", target: 3001, protocol: "tcp" },
  ]);
});

test("production web binds loopback and keeps its database network connection", () => {
  const result = resolveConfig("docker:up:prod", "web");
  expect(result.exitCode).toBe(0);
  const { web } = JSON.parse(result.stdout.toString()).services;
  expect(web.ports).toEqual([
    {
      mode: "ingress",
      host_ip: "127.0.0.1",
      published: "3001",
      target: 3001,
      protocol: "tcp",
    },
  ]);
  const database = new URL(web.environment.DATABASE_URL);
  expect(database.hostname).toBe("postgres");
  expect(database.port).toBe("5432");
});

test("local Postgres publishes 5432 without a master key", async () => {
  await writeFile(path.join(missingKeyFixture, "apps/web/.env"), "");
  const result = resolveConfig("db:start", "postgres", missingKeyFixture);
  expect(result.exitCode).toBe(0);
  expect(
    JSON.parse(result.stdout.toString()).services.postgres.ports
  ).toContainEqual(
    expect.objectContaining({ published: "5432", target: 5432 })
  );
});

test.each(
  (["docker:up", "docker:up:prod"] as const).flatMap((script) => [
    { script, name: "unset", contents: "", override: undefined },
    { script, name: "empty", contents: "VAULT_MASTER_KEY=\n", override: "" },
  ])
)(
  "$script rejects an $name master key",
  async ({ script, contents, override }) => {
    await writeFile(path.join(missingKeyFixture, "apps/web/.env"), contents);
    const result = resolveConfig(script, "web", missingKeyFixture, override);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("VAULT_MASTER_KEY");
  }
);
