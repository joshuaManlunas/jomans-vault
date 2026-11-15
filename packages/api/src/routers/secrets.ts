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
import { and, eq, isNull, sql } from "drizzle-orm";
import * as z from "zod";

import type { Context } from "../context";
import { authedProcedure } from "../index";
import { audit } from "../middleware/audit";
import { requireScope } from "../middleware/require-scope";
import { secretKey, slug } from "./validation";

const encoder = new TextEncoder();
const pathInput = z.object({ project: slug, env: slug, key: secretKey });
const value = z
  .string()
  .refine((input) => input.isWellFormed())
  .refine((input) => encoder.encode(input).byteLength <= 65_536);
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

export const secretsRouter = {
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
            updatedAt: sql`now()`,
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
