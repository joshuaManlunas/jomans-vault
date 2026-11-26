import { readSync } from "node:fs";

import {
  isReservedEnvName,
  reservedEnvNameMessage,
} from "@jomans-vault/api/reserved-env";
import * as z from "zod";

import type { CredentialStore } from "./credentials";
import { UsageError } from "./errors";
import { readHiddenValue } from "./prompt";

const keyPattern = /^[A-Z_][A-Z0-9_]*$/u;
const maxValueBytes = 65_536;
const keySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(keyPattern)
  .refine((key) => key === key.trim());
const metadataSchema = z.object({
  key: keySchema,
  kind: z.enum(["secret", "env", "token"]),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
const revealedSchema = z.object({
  key: keySchema,
  value: z.string(),
  version: z.number().int().positive(),
});
const versionsSchema = z.array(
  z.object({
    version: z.number().int().positive(),
    createdByType: z.enum(["user", "apiKey"]),
    createdById: z.string(),
    createdAt: z.iso.datetime(),
  })
);

interface Target {
  url: string;
  project: string;
  environment: string;
  credentials: CredentialStore;
}
interface KeyTarget extends Target {
  key: string;
}

const validateKey = (key: string) => {
  if (!keySchema.safeParse(key).success) {
    throw new UsageError(
      "Invalid secret key. Use 1 to 255 uppercase letters, digits or underscores, starting with a letter or underscore."
    );
  }
};

const validateWriteKey = (key: string) => {
  validateKey(key);
  if (isReservedEnvName(key)) {
    throw new UsageError(reservedEnvNameMessage(key));
  }
};

const vaultRequest = async <T>({
  url,
  project,
  environment,
  credentials,
  key,
  permission,
  method = "GET",
  suffix = "",
  body,
  schema,
}: Target & {
  key?: string;
  permission: "read" | "reveal" | "write" | "delete";
  method?: "GET" | "PUT" | "DELETE";
  suffix?: string;
  body?: { value: string };
  schema: z.ZodType<T>;
}): Promise<T> => {
  const storedKey = await credentials.get(url);
  if (!storedKey) {
    throw new Error(`Not logged in to ${url}. Run jv login.`);
  }
  let response: Response;
  let text = "";
  try {
    response = await fetch(
      `${url}/api/v1/projects/${project}/envs/${environment}/secrets${key === undefined ? "" : `/${key}`}${suffix}`,
      {
        method,
        headers: {
          "x-api-key": storedKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      }
    );
    if (response.ok) {
      text = await response.text();
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
      `The stored key for ${url} lacks the ${permission} permission for ${project}/${environment}, or is not scoped to it. Run jv login to get a key with ${permission}.`
    );
  }
  if (response.status === 404) {
    throw new Error(
      permission === "write" || key === undefined
        ? `Project ${project} or environment ${environment} not found at ${url}.`
        : `Secret ${key} not found in ${project}/${environment} at ${url}, or the project or environment does not exist.`
    );
  }
  if (response.status === 409) {
    throw new Error(
      `${key === undefined ? "" : `${key} in `}${project}/${environment} was changed by someone else. Run the command again.`
    );
  }
  try {
    if (response.status === (method === "DELETE" ? 204 : 200)) {
      return schema.parse(method === "DELETE" ? undefined : JSON.parse(text));
    }
  } catch {
    // Never echo response bodies or validation errors containing secret values.
  }
  throw new Error(
    `The vault at ${url} returned an unexpected response (${response.status}).`
  );
};

export const listSecrets = async (target: Target) =>
  await vaultRequest({
    ...target,
    permission: "read",
    schema: z.array(metadataSchema),
  });

export const ls = async (target: Target): Promise<number> => {
  const rows = await listSecrets(target);
  if (rows.length === 0) {
    console.error(`No secrets in ${target.project}/${target.environment}.`);
    return 0;
  }
  const width = Math.max(...rows.map((row) => row.key.length));
  for (const row of rows) {
    console.info(
      `${row.key.padEnd(width)}  ${row.kind.padEnd(6)}  v${row.version}  ${row.updatedAt}`
    );
  }
  return 0;
};

export const get = async (target: KeyTarget): Promise<number> => {
  validateKey(target.key);
  const row = await vaultRequest({
    ...target,
    permission: "reveal",
    schema: revealedSchema,
  });
  process.stdout.write(row.value);
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }
  return 0;
};

const readStdin = (): string => {
  const bytes = Buffer.alloc(maxValueBytes + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(0, bytes, length, bytes.length - length, null);
    if (count === 0) {
      break;
    }
    length += count;
  }
  if (length > maxValueBytes) {
    throw new UsageError("The value is larger than 64 KiB.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, length)
    );
  } catch {
    throw new UsageError("The value is not valid UTF-8 text.");
  }
};

export const storeSecret = async (target: KeyTarget & { value: string }) => {
  validateWriteKey(target.key);
  const { value } = target;
  if (!value.isWellFormed()) {
    throw new UsageError("The value is not valid UTF-8 text.");
  }
  if (Buffer.byteLength(value, "utf-8") > maxValueBytes) {
    throw new UsageError("The value is larger than 64 KiB.");
  }
  return await vaultRequest({
    ...target,
    permission: "write",
    method: "PUT",
    body: { value },
    schema: metadataSchema,
  });
};

export const set = async (
  target: KeyTarget & { value?: string }
): Promise<number> => {
  validateWriteKey(target.key);
  let { value } = target;
  if (value === "-") {
    value = readStdin();
  } else if (value === undefined) {
    if (!process.stdin.isTTY) {
      throw new UsageError(
        "No value given and stdin is not a terminal. Pass a value, or - to read it from stdin."
      );
    }
    const entered = await readHiddenValue(target.key);
    if (entered === null) {
      return 130;
    }
    if (entered === "") {
      throw new Error("No value entered. Nothing stored.");
    }
    value = entered;
  }
  const row = await storeSecret({ ...target, value });
  console.error(
    `Stored ${target.key} in ${target.project}/${target.environment} (version ${row.version}).`
  );
  return 0;
};

export const rm = async (target: KeyTarget): Promise<number> => {
  validateKey(target.key);
  await vaultRequest({
    ...target,
    permission: "delete",
    method: "DELETE",
    schema: z.undefined(),
  });
  console.error(
    `Removed ${target.key} from ${target.project}/${target.environment}.`
  );
  return 0;
};

export const history = async (target: KeyTarget): Promise<number> => {
  validateKey(target.key);
  const rows = await vaultRequest({
    ...target,
    permission: "read",
    suffix: "/versions",
    schema: versionsSchema,
  });
  for (const row of rows) {
    console.info(
      `v${row.version}  ${row.createdAt}  ${row.createdByType} ${row.createdById}`
    );
  }
  return 0;
};
