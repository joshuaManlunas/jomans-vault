import { mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import pathModule from "node:path";

import * as z from "zod";

import { UsageError } from "./errors";

export const configDir = (env: NodeJS.ProcessEnv): string =>
  pathModule.join(
    env.XDG_CONFIG_HOME && pathModule.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : pathModule.join(env.HOME || homedir(), ".config"),
    "jv"
  );

export const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

export const writePrivateJson = async (path: string, value: unknown) => {
  const file = await open(path, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`);
  } finally {
    await file.close();
  }
};

export const readRememberedUrl = async (
  env: NodeJS.ProcessEnv
): Promise<string | null> => {
  const value = await readJson(pathModule.join(configDir(env), "config.json"));
  return value === null ? null : z.object({ url: z.string() }).parse(value).url;
};

export const writeRememberedUrl = async (
  env: NodeJS.ProcessEnv,
  url: string
) => {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writePrivateJson(pathModule.join(dir, "config.json"), { url });
};

export const resolveVaultUrl = async ({
  flag,
  env,
}: {
  flag?: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> => {
  const value = flag ?? (env.JV_URL || (await readRememberedUrl(env)));
  if (value === null || value === undefined) {
    throw new UsageError(
      "No vault URL. Pass --url <url>, set JV_URL, or log in once with --url."
    );
  }
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.origin + url.pathname.replace(/\/+$/u, "");
    }
  } catch {
    // Report all invalid URL forms with the same usage message.
  }
  throw new UsageError(
    `Invalid vault URL "${value}": use an http:// or https:// URL.`
  );
};
