import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../factory/preflight.sh", import.meta.url));
const bin = mkdtempSync(path.join(tmpdir(), "preflight-bin-"));

// Fake docker and lsof: `docker ps` prints $FAKE_DOCKER_PS, `lsof` prints $FAKE_LSOF.
writeFileSync(
  path.join(bin, "docker"),
  '#!/bin/sh\n[ "$1" = ps ] && printf "%b" "$FAKE_DOCKER_PS"\nexit 0\n'
);
writeFileSync(
  path.join(bin, "lsof"),
  '#!/bin/sh\nprintf "%b" "$FAKE_LSOF"\nexit 0\n'
);
chmodSync(path.join(bin, "docker"), 0o755);
chmodSync(path.join(bin, "lsof"), 0o755);

afterAll(() => rmSync(bin, { force: true, recursive: true }));

const run = (dockerPs: string, lsof = "") => {
  const result = Bun.spawnSync(["bash", hook], {
    env: {
      FAKE_DOCKER_PS: dockerPs,
      FAKE_LSOF: lsof,
      PATH: `${bin}:/usr/bin:/bin`,
    },
    stderr: "pipe",
  });
  return { code: result.exitCode, stderr: result.stderr.toString() };
};

test.each([
  {
    name: "our container on host 5432 passes",
    ps: "jomans-vault-postgres\t0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp\n",
    code: 0,
    stderr: "",
  },
  {
    name: "our container on another host port fails even though it exposes 5432",
    ps: "jomans-vault-postgres\t0.0.0.0:15432->5432/tcp\n",
    code: 1,
    stderr: "jomans-vault-postgres is not serving port 5432",
  },
  {
    name: "another container on host 5432 is named",
    ps: "jomans-vault-postgres\t0.0.0.0:15432->5432/tcp\nother-db\t127.0.0.1:5432->5432/tcp\n",
    code: 1,
    stderr: "another Docker container (other-db)",
  },
  {
    name: "a host 55432 binding does not count as 5432",
    ps: "other-db\t127.0.0.1:55432->5432/tcp\n",
    code: 1,
    stderr: "jomans-vault-postgres is not serving port 5432",
  },
])("preflight: $name", ({ ps, code, stderr }) => {
  const result = run(ps);
  expect(result.code).toBe(code);
  expect(result.stderr).toContain(stderr);
});

test("preflight names a non-Docker process holding 5432", () => {
  const result = run(
    "",
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\npostgres 4242 me 7u IPv4 0x0 0t0 TCP *:5432 (LISTEN)\n"
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("another process (postgres (pid 4242))");
});
