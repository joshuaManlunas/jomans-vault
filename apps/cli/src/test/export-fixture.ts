import { expect } from "bun:test";

import { approvalRequestId, spawnJv, startVault } from "./harness";
import type { JvResult, Sandbox } from "./harness";

export const secretValues = {
  FOO: "private-export-foo",
  BAR: "private-export-bar",
  PEM: "x\n",
};

export const startExportFixture = async () => {
  const vault = await startVault();
  const keys = new Set<string>();
  const noLeaks = (output: JvResult, includesValues = false) => {
    for (const key of keys) {
      expect(output.stdout).not.toContain(key);
      expect(output.stderr).not.toContain(key);
    }
    for (const value of [
      secretValues.FOO,
      secretValues.BAR,
      "private-staging-foo",
    ]) {
      expect(output.stderr).not.toContain(value);
      if (!includesValues) {
        expect(output.stdout).not.toContain(value);
      }
    }
  };
  try {
    const { cookie } = await vault.signup("export-owner@example.com");
    const project = await vault.api("POST", "/projects", {
      cookie,
      body: { slug: "my-app", name: "My app" },
    });
    expect(project.status).toBe(201);
    await Promise.all(
      ["development", "staging", "empty"].map(async (environment) => {
        const created = await vault.api("POST", "/projects/my-app/envs", {
          cookie,
          body: { slug: environment },
        });
        expect(created.status).toBe(201);
        if (environment === "empty") {
          return;
        }
        const values =
          environment === "development"
            ? secretValues
            : { FOO: "private-staging-foo" };
        await Promise.all(
          Object.entries(values).map(async ([key, value]) => {
            const stored = await vault.api(
              "PUT",
              `/projects/my-app/envs/${environment}/secrets/${key}`,
              { cookie, body: { value } }
            );
            expect(stored.status).toBe(200);
          })
        );
      })
    );
    const authenticate = async (
      box: Sandbox,
      permissions: readonly string[] = ["read", "inject"]
    ) => {
      const child = spawnJv(["login", "--no-browser", "--url", vault.url], box);
      try {
        const id = approvalRequestId(
          await child.waitForStderr(/Open this link/u)
        );
        const approved = await vault.api(
          "POST",
          `/login-requests/${id}/approve`,
          {
            cookie,
            body: {
              scope: {
                projects: { "my-app": ["development", "staging", "empty"] },
              },
              permissions,
            },
          }
        );
        expect(approved.status).toBe(200);
        const output = await child.waitForExit();
        expect(output.exitCode).toBe(0);
        const entries = await box.keychain();
        const key = entries.jv?.[vault.url];
        if (!key) {
          throw new Error("Expected a stored test credential");
        }
        keys.add(key);
        noLeaks(output);
        return key;
      } finally {
        if (child.process.exitCode === null) {
          child.process.kill("SIGKILL");
        }
        await child.exited;
      }
    };
    return { vault, authenticate, noLeaks };
  } catch (error) {
    await vault.stop();
    throw error;
  }
};
