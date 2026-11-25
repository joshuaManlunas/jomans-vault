import { chmod, mkdir, rm } from "node:fs/promises";
import pathModule from "node:path";

import * as z from "zod";

import { configDir, readJson, writePrivateJson } from "./config";
import { UsageError } from "./errors";

export type StoredLocation =
  | { kind: "keychain" }
  | { kind: "file"; path: string };
export interface CredentialStore {
  get: (url: string) => Promise<string | null>;
  set: (url: string, key: string) => Promise<StoredLocation>;
  delete: (url: string) => Promise<boolean>;
}

const entriesSchema = z.record(z.string(), z.string());
const readEntries = async (path: string) =>
  entriesSchema.parse((await readJson(path)) ?? {});
const privateDir = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};
const removeEntry = async (path: string, url: string): Promise<boolean> => {
  const entries = await readEntries(path);
  if (!(url in entries)) {
    return false;
  }
  const remaining = Object.fromEntries(
    Object.entries(entries).filter(([name]) => name !== url)
  );
  await (Object.keys(remaining).length === 0
    ? rm(path)
    : writePrivateJson(path, remaining));
  return true;
};

const createKeychain = (env: NodeJS.ProcessEnv) => {
  const test = env.JV_TEST_KEYCHAIN;
  if (!test) {
    return Bun.secrets;
  }
  if (test !== "unavailable" && !pathModule.isAbsolute(test)) {
    throw new UsageError(
      "Invalid JV_TEST_KEYCHAIN: use an absolute directory path or unavailable."
    );
  }
  const path = pathModule.join(test, "keychain.json");
  const read = async () => {
    if (test === "unavailable") {
      throw new Error("Test keychain is unavailable");
    }
    return z
      .record(z.string(), entriesSchema)
      .parse((await readJson(path)) ?? {});
  };
  return {
    get: async ({ service, name }: { service: string; name: string }) => {
      const entries = await read();
      return entries[service]?.[name] ?? null;
    },
    set: async ({
      service,
      name,
      value,
    }: {
      service: string;
      name: string;
      value: string;
    }) => {
      const entries = await read();
      entries[service] ??= {};
      entries[service][name] = value;
      await privateDir(test);
      await writePrivateJson(path, entries);
    },
    delete: async ({ service, name }: { service: string; name: string }) => {
      const entries = await read();
      const removed = entries[service]?.[name] !== undefined;
      if (removed) {
        entries[service] = Object.fromEntries(
          Object.entries(entries[service] ?? {}).filter(([key]) => key !== name)
        );
        await writePrivateJson(path, entries);
      }
      return removed;
    },
  };
};

export const createCredentialStore = (
  env: NodeJS.ProcessEnv
): CredentialStore => {
  const keychain = createKeychain(env);
  const dir = configDir(env);
  const path = pathModule.join(dir, "credentials.json");
  return {
    get: async (url) => {
      try {
        const key = await keychain.get({ service: "jv", name: url });
        if (key !== null) {
          return key;
        }
      } catch {
        // An unavailable OS keychain must not prevent fallback lookup.
      }
      const entries = await readEntries(path);
      return entries[url] ?? null;
    },
    set: async (url, key) => {
      try {
        await keychain.set({ service: "jv", name: url, value: key });
      } catch {
        const entries = await readEntries(path);
        entries[url] = key;
        await privateDir(dir);
        await writePrivateJson(path, entries);
        return { kind: "file", path };
      }
      await removeEntry(path, url);
      return { kind: "keychain" };
    },
    delete: async (url) => {
      let removed = false;
      try {
        removed = await keychain.delete({ service: "jv", name: url });
      } catch {
        // A missing OS keychain must not prevent fallback cleanup.
      }
      return (await removeEntry(path, url)) || removed;
    },
  };
};
