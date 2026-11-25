import { mkdir, open, readFile, writeFile } from "node:fs/promises";
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
  linked,
}: {
  flag?: string;
  linked?: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> => {
  const value =
    flag ?? (env.JV_URL || linked || (await readRememberedUrl(env)));
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

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/u);
const linkSchema = z.object({
  project: slugSchema,
  env: slugSchema,
  url: z.string().optional(),
});
type Link = z.infer<typeof linkSchema>;

export const validateSlug = (value: string): void => {
  if (!slugSchema.safeParse(value).success) {
    throw new UsageError(
      "Invalid project or environment: use 1 to 64 lowercase letters, numbers or hyphens."
    );
  }
};

export const findLink = async (
  cwd: string
): Promise<(Link & { path: string }) | null> => {
  let dir = pathModule.resolve(cwd);
  while (true) {
    const path = pathModule.join(dir, "jv.json");
    let contents: string | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop -- Search each ancestor only after the nearer file is absent.
      contents = await readFile(path, "utf-8");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw new UsageError(`Could not read jv.json at ${path}.`);
      }
    }
    if (contents !== undefined) {
      let value: Link;
      try {
        value = linkSchema.parse(JSON.parse(contents));
      } catch {
        throw new UsageError(
          `Invalid jv.json at ${path}: expected {"project": "<slug>", "env": "<slug>"} with an optional "url".`
        );
      }
      if (value.url !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- Validate the nearest link before returning it.
        value.url = await resolveVaultUrl({ flag: value.url, env: {} });
      }
      return { path, ...value };
    }
    const parent = pathModule.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
};

export const writeLink = async (dir: string, link: Link): Promise<void> => {
  await writeFile(
    pathModule.join(dir, "jv.json"),
    `${JSON.stringify({ project: link.project, env: link.env, url: link.url }, null, 2)}\n`
  );
};
