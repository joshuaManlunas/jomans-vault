import {
  decryptValue,
  encryptValue,
  IntegrityError,
  unwrapDek,
} from "@jomans-vault/crypto";
import {
  projectKey,
  secret,
  secretVersion,
} from "@jomans-vault/db/schema/vault";
import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import * as z from "zod";

import type { Context } from "../context";
import { DotenvValueError, formatDotenv } from "../dotenv";
import { authedProcedure } from "../index";
import { audit } from "../middleware/audit";
import { requireScope } from "../middleware/require-scope";
import { isUniqueViolation, secretKey, slug } from "./validation";

const encoder = new TextEncoder();
const pathInput = z.object({ project: slug, env: slug, key: secretKey });
const value = z
  .string()
  .refine((input) => input.isWellFormed())
  .refine((input) => encoder.encode(input).byteLength <= 65_536);
const versionNumber = z.number().int().min(1).max(2_147_483_647);
const writeOutput = z.object({
  key: z.string(),
  kind: z.string(),
  version: z.number(),
  updatedAt: z.date().transform((date) => date.toISOString()),
});
const auditTarget = ({ output }: { output: unknown }) =>
  z
    .object({
      projectId: z.string(),
      environmentId: z.string(),
      secretId: z.string(),
    })
    .parse(output);

const rethrowIntegrityError = (error: unknown): never => {
  if (error instanceof IntegrityError) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Secret integrity check failed",
    });
  }
  throw error;
};

const projectDek = async (context: Context, projectId: string) => {
  const [key] = await context.db
    .select()
    .from(projectKey)
    .where(
      and(eq(projectKey.projectId, projectId), isNull(projectKey.retiredAt))
    );
  if (!key) {
    throw new Error("Project data key not found");
  }
  try {
    return await unwrapDek(key, context.masterKey);
  } catch (error) {
    return rethrowIntegrityError(error);
  }
};

// The caller holds the secret row lock until the audit transaction commits.
const appendVersion = async (
  context: Context,
  secretId: string,
  encrypted: { ciphertext: Uint8Array; iv: Uint8Array },
  actorId: string
) => {
  const [next] = await context.db
    .select({
      version: sql<number>`coalesce(max(${secretVersion.version}), 0) + 1`,
    })
    .from(secretVersion)
    .where(eq(secretVersion.secretId, secretId));
  if (!next) {
    throw new ORPCError("INTERNAL_SERVER_ERROR");
  }
  const [created] = await context.db
    .insert(secretVersion)
    .values({
      secretId,
      version: next.version,
      ciphertext: Buffer.from(encrypted.ciphertext),
      iv: Buffer.from(encrypted.iv),
      createdByType: "user",
      createdById: actorId,
    })
    .returning({ id: secretVersion.id });
  if (!created) {
    throw new ORPCError("INTERNAL_SERVER_ERROR");
  }
  const [updated] = await context.db
    .update(secret)
    .set({
      currentVersionId: created.id,
      updatedAt: sql`clock_timestamp()`,
      deletedAt: null,
    })
    .where(eq(secret.id, secretId))
    .returning();
  if (!updated) {
    throw new ORPCError("INTERNAL_SERVER_ERROR");
  }
  return { ...updated, secretId, version: next.version };
};

export const secretsRouter = {
  export: authedProcedure
    .route({
      method: "GET",
      path: "/projects/{project}/envs/{env}/export",
    })
    .input(
      z.object({
        project: slug,
        env: slug,
        format: z.enum(["json", "dotenv"]).default("json"),
      })
    )
    .output(
      z.union([
        z.record(z.string(), z.string()),
        z.file().mime("text/plain; charset=utf-8"),
      ])
    )
    .use(requireScope, (input) => ({ project: input.project, env: input.env }))
    .use(
      audit("secret.export", ({ context }) => {
        if (!(context.project && context.environment)) {
          throw new ORPCError("NOT_FOUND");
        }
        return {
          projectId: context.project.id,
          environmentId: context.environment.id,
        };
      })
    )
    .handler(async ({ context, input }) => {
      if (!context.environment) {
        throw new ORPCError("NOT_FOUND");
      }
      const rows = await context.db
        .select({
          key: secret.key,
          ciphertext: secretVersion.ciphertext,
          iv: secretVersion.iv,
        })
        .from(secret)
        .innerJoin(secretVersion, eq(secret.currentVersionId, secretVersion.id))
        .where(
          and(
            eq(secret.environmentId, context.environment.id),
            isNull(secret.deletedAt)
          )
        )
        .orderBy(asc(secret.key));
      const dek = await projectDek(context, context.project.id);
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
      let entries;
      try {
        entries = await Promise.all(
          rows.map(async (row) => ({
            key: row.key,
            value: decoder.decode(await decryptValue(row, dek)),
          }))
        );
      } catch (error) {
        return rethrowIntegrityError(error);
      }
      if (input.format === "json") {
        return Object.fromEntries(
          entries.map(({ key, value: plaintext }) => [key, plaintext])
        );
      }
      try {
        return new File([formatDotenv(entries)], "export", {
          type: "text/plain; charset=utf-8",
        });
      } catch (error) {
        if (error instanceof DotenvValueError) {
          throw new ORPCError("UNPROCESSABLE_CONTENT", {
            message: error.message,
          });
        }
        throw error;
      }
    }),
  list: authedProcedure
    .route({
      method: "GET",
      path: "/projects/{project}/envs/{env}/secrets",
    })
    .input(z.object({ project: slug, env: slug }))
    .output(
      z.array(
        z.object({
          key: z.string(),
          kind: z.string().pipe(z.enum(["secret", "env", "token"])),
          version: z.number(),
          updatedAt: z.date().transform((date) => date.toISOString()),
        })
      )
    )
    .use(requireScope, (input) => ({ project: input.project, env: input.env }))
    .handler(async ({ context }) => {
      if (!context.environment) {
        throw new ORPCError("NOT_FOUND");
      }
      return await context.db
        .select({
          key: secret.key,
          kind: secret.kind,
          version: secretVersion.version,
          updatedAt: secret.updatedAt,
        })
        .from(secret)
        .innerJoin(secretVersion, eq(secret.currentVersionId, secretVersion.id))
        .where(
          and(
            eq(secret.environmentId, context.environment.id),
            isNull(secret.deletedAt)
          )
        )
        .orderBy(asc(secret.key));
    }),
  delete: authedProcedure
    .route({
      method: "DELETE",
      path: "/projects/{project}/envs/{env}/secrets/{key}",
      successStatus: 204,
    })
    .input(pathInput)
    .output(
      z
        .object({
          projectId: z.string(),
          environmentId: z.string(),
          secretId: z.string(),
        })
        .transform(() => {
          // A 204 response discards the internal audit target.
        })
    )
    .use(requireScope, (input) => ({ project: input.project, env: input.env }))
    .use(audit("secret.delete", auditTarget))
    .handler(async ({ context, input }) => {
      if (!context.environment) {
        throw new ORPCError("NOT_FOUND");
      }
      const [deleted] = await context.db
        .update(secret)
        .set({ deletedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(secret.environmentId, context.environment.id),
            eq(secret.key, input.key),
            isNull(secret.deletedAt)
          )
        )
        .returning({
          secretId: secret.id,
          environmentId: secret.environmentId,
        });
      if (!deleted) {
        throw new ORPCError("NOT_FOUND");
      }
      return { ...deleted, projectId: context.project.id };
    }),
  versions: authedProcedure
    .route({
      method: "GET",
      path: "/projects/{project}/envs/{env}/secrets/{key}/versions",
    })
    .input(pathInput)
    .output(
      z.array(
        z.object({
          version: z.number(),
          createdByType: z.string(),
          createdById: z.string(),
          createdAt: z.date().transform((date) => date.toISOString()),
        })
      )
    )
    .use(requireScope, (input) => ({ project: input.project, env: input.env }))
    .handler(async ({ context, input }) => {
      if (!context.environment) {
        throw new ORPCError("NOT_FOUND");
      }
      const [row] = await context.db
        .select({ id: secret.id })
        .from(secret)
        .where(
          and(
            eq(secret.environmentId, context.environment.id),
            eq(secret.key, input.key)
          )
        )
        .orderBy(
          sql`${secret.deletedAt} DESC NULLS FIRST`,
          desc(secret.createdAt),
          desc(secret.id)
        )
        .limit(1);
      if (!row) {
        throw new ORPCError("NOT_FOUND");
      }
      return await context.db
        .select({
          version: secretVersion.version,
          createdByType: secretVersion.createdByType,
          createdById: secretVersion.createdById,
          createdAt: secretVersion.createdAt,
        })
        .from(secretVersion)
        .where(eq(secretVersion.secretId, row.id))
        .orderBy(asc(secretVersion.version));
    }),
  set: authedProcedure
    .route({
      method: "PUT",
      path: "/projects/{project}/envs/{env}/secrets/{key}",
    })
    .input(
      pathInput.extend({
        value,
        kind: z.enum(["secret", "env", "token"]).optional(),
        description: z.string().max(500).optional(),
      })
    )
    .output(
      z.object({
        key: z.string(),
        kind: z.string(),
        version: z.number(),
        updatedAt: z.date().transform((date) => date.toISOString()),
      })
    )
    .use(requireScope, (input) => ({ project: input.project, env: input.env }))
    .use(audit("secret.write", auditTarget))
    .handler(async ({ context, input }) => {
      if (!context.environment) {
        throw new ORPCError("NOT_FOUND");
      }
      const dek = await projectDek(context, context.project.id);
      const encrypted = await encryptValue(encoder.encode(input.value), dek);
      const [row] = await context.db
        .insert(secret)
        .values({
          environmentId: context.environment.id,
          key: input.key,
          kind: input.kind ?? "secret",
          description: input.description || null,
        })
        .onConflictDoUpdate({
          target: [secret.environmentId, secret.key],
          targetWhere: isNull(secret.deletedAt),
          set: {
            updatedAt: sql`clock_timestamp()`,
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.description === undefined
              ? {}
              : { description: input.description || null }),
          },
        })
        .returning();
      if (!row) {
        throw new ORPCError("INTERNAL_SERVER_ERROR");
      }
      const [next] = await context.db
        .select({
          version: sql<number>`coalesce(max(${secretVersion.version}), 0) + 1`,
        })
        .from(secretVersion)
        .where(eq(secretVersion.secretId, row.id));
      if (!next) {
        throw new ORPCError("INTERNAL_SERVER_ERROR");
      }
      const [created] = await context.db
        .insert(secretVersion)
        .values({
          secretId: row.id,
          version: next.version,
          ciphertext: Buffer.from(encrypted.ciphertext),
          iv: Buffer.from(encrypted.iv),
          createdByType: "user",
          createdById: context.principal.user.id,
        })
        .returning({ id: secretVersion.id });
      if (!created) {
        throw new ORPCError("INTERNAL_SERVER_ERROR");
      }
      await context.db
        .update(secret)
        .set({ currentVersionId: created.id })
        .where(eq(secret.id, row.id));
      return {
        ...row,
        version: next.version,
        projectId: context.project.id,
        secretId: row.id,
      };
    }),
  patch: authedProcedure
    .route({
      method: "PATCH",
      path: "/projects/{project}/envs/{env}/secrets/{key}",
    })
    .input(pathInput.extend({ value, expectedVersion: versionNumber }))
    .output(writeOutput)
    .use(requireScope, (input) => ({ project: input.project, env: input.env }))
    .use(audit("secret.write", auditTarget))
    .handler(async ({ context, input }) => {
      if (!context.environment) {
        throw new ORPCError("NOT_FOUND");
      }
      const [row] = await context.db
        .select()
        .from(secret)
        .where(
          and(
            eq(secret.environmentId, context.environment.id),
            eq(secret.key, input.key),
            isNull(secret.deletedAt)
          )
        )
        .for("update");
      if (!row) {
        throw new ORPCError("NOT_FOUND");
      }
      const [current] = await context.db
        .select({ version: secretVersion.version })
        .from(secret)
        .innerJoin(secretVersion, eq(secret.currentVersionId, secretVersion.id))
        .where(eq(secret.id, row.id));
      if (current?.version !== input.expectedVersion) {
        throw new ORPCError("CONFLICT");
      }
      const dek = await projectDek(context, context.project.id);
      const encrypted = await encryptValue(encoder.encode(input.value), dek);
      return {
        ...(await appendVersion(
          context,
          row.id,
          encrypted,
          context.principal.user.id
        )),
        projectId: context.project.id,
      };
    }),
  rollback: authedProcedure
    .route({
      method: "POST",
      path: "/projects/{project}/envs/{env}/secrets/{key}/rollback",
    })
    .input(pathInput.extend({ version: versionNumber }))
    .output(writeOutput)
    .use(requireScope, (input) => ({ project: input.project, env: input.env }))
    .use(audit("secret.rollback", auditTarget))
    .handler(async ({ context, input }) => {
      if (!context.environment) {
        throw new ORPCError("NOT_FOUND");
      }
      const [row] = await context.db
        .select()
        .from(secret)
        .where(
          and(
            eq(secret.environmentId, context.environment.id),
            eq(secret.key, input.key)
          )
        )
        .orderBy(
          sql`${secret.deletedAt} DESC NULLS FIRST`,
          desc(secret.createdAt),
          desc(secret.id)
        )
        .limit(1)
        .for("update");
      if (!row) {
        throw new ORPCError("NOT_FOUND");
      }
      const [source] = await context.db
        .select()
        .from(secretVersion)
        .where(
          and(
            eq(secretVersion.secretId, row.id),
            eq(secretVersion.version, input.version)
          )
        );
      if (!source) {
        throw new ORPCError("NOT_FOUND");
      }
      try {
        return {
          ...(await appendVersion(
            context,
            row.id,
            source,
            context.principal.user.id
          )),
          projectId: context.project.id,
        };
      } catch (error) {
        if (isUniqueViolation(error, "secret_environment_id_key_live_unique")) {
          throw new ORPCError("CONFLICT");
        }
        throw error;
      }
    }),
  get: authedProcedure
    .route({
      method: "GET",
      path: "/projects/{project}/envs/{env}/secrets/{key}",
    })
    .input(pathInput)
    .output(
      z.object({ key: z.string(), value: z.string(), version: z.number() })
    )
    .use(requireScope, (input) => ({ project: input.project, env: input.env }))
    .use(audit("secret.reveal", auditTarget))
    .handler(async ({ context, input }) => {
      if (!context.environment) {
        throw new ORPCError("NOT_FOUND");
      }
      const [row] = await context.db
        .select({ secret, secretVersion })
        .from(secret)
        .innerJoin(secretVersion, eq(secret.currentVersionId, secretVersion.id))
        .where(
          and(
            eq(secret.environmentId, context.environment.id),
            eq(secret.key, input.key),
            isNull(secret.deletedAt)
          )
        );
      if (!row) {
        throw new ORPCError("NOT_FOUND");
      }
      const dek = await projectDek(context, context.project.id);
      let plaintext;
      try {
        plaintext = await decryptValue(row.secretVersion, dek);
      } catch (error) {
        return rethrowIntegrityError(error);
      }
      return {
        key: row.secret.key,
        value: new TextDecoder("utf-8", { ignoreBOM: true }).decode(plaintext),
        version: row.secretVersion.version,
        projectId: context.project.id,
        environmentId: row.secret.environmentId,
        secretId: row.secret.id,
      };
    }),
};
