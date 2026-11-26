import { constants } from "node:os";

import { isReservedEnvName } from "@jomans-vault/api/reserved-env";
import * as z from "zod";

import type { CredentialStore } from "./credentials";

const exportSchema = z.record(z.string(), z.string());

export const fetchValues = async (
  url: string,
  project: string,
  environment: string,
  key: string
): Promise<Record<string, string>> => {
  let response: Response;
  let body = "";
  try {
    response = await fetch(
      `${url}/api/v1/projects/${project}/envs/${environment}/export`,
      {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      }
    );
    if (response.ok) {
      body = await response.text();
    }
  } catch {
    throw new Error(`Could not reach the vault at ${url}.`);
  }
  if (response.status === 401) {
    throw new Error(
      `The vault at ${url} rejected the stored key. Run jv login again.`
    );
  }
  if (response.status === 403) {
    throw new Error(
      `The stored key for ${url} cannot inject ${project}/${environment}: it lacks the inject permission or is not scoped to it. Run jv login to get a key for it.`
    );
  }
  if (response.status === 404) {
    throw new Error(
      `Project ${project} or environment ${environment} not found at ${url}.`
    );
  }
  try {
    if (response.ok) {
      return exportSchema.parse(JSON.parse(body));
    }
  } catch {
    // Never include response bodies or validation errors containing secret values.
  }
  throw new Error(
    `The vault at ${url} returned an unexpected response (${response.status}).`
  );
};

export const exportValues = async ({
  url,
  project,
  environment,
  credentials,
}: {
  url: string;
  project: string;
  environment: string;
  credentials: CredentialStore;
}): Promise<Record<string, string>> => {
  const key = await credentials.get(url);
  if (!key) {
    throw new Error(`Not logged in to ${url}. Run jv login.`);
  }
  return await fetchValues(url, project, environment, key);
};

export const run = async ({
  url,
  project,
  environment,
  command,
  env,
  credentials,
}: {
  url: string;
  project: string;
  environment: string;
  command: string[];
  env: NodeJS.ProcessEnv;
  credentials: CredentialStore;
}): Promise<number> => {
  const values = await exportValues({ url, project, environment, credentials });
  const skippedKeys = Object.keys(values).filter(isReservedEnvName).toSorted();
  const injectedValues = Object.fromEntries(
    Object.entries(values).filter(([name]) => !isReservedEnvName(name))
  );
  if (skippedKeys.length > 0) {
    console.error(
      `Skipped ${skippedKeys.join(", ")}: reserved names that control how programs start are never injected.`
    );
  }
  let child: Bun.Subprocess<"inherit", "inherit", "inherit">;
  try {
    child = Bun.spawn(command, {
      env: { ...env, ...injectedValues },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
    console.error(`Could not start ${command[0]}.`);
    return 127;
  }
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const exitCode = await child.exited;
    const signal = child.signalCode;
    if (signal) {
      return (
        128 + (typeof signal === "number" ? signal : constants.signals[signal])
      );
    }
    return exitCode;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
};
