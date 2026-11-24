import { apikey } from "@jomans-vault/db/schema/auth";
import { environment, project } from "@jomans-vault/db/schema/vault";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import * as z from "zod";

import { userProcedure } from "../index";
import { recordAuditEvent } from "../middleware/audit";
import { slug } from "./validation";

const permissionNames = [
  "read",
  "reveal",
  "inject",
  "write",
  "delete",
] as const;
const permission = z.enum(permissionNames);
const scopeSchema = z.object({
  projects: z.record(z.string(), z.array(z.string())),
});
const storedPermissions = z.object({ secrets: z.array(z.unknown()) });
const summaryOutput = z.object({
  id: z.string(),
  name: z.string().nullable(),
  scope: scopeSchema,
  permissions: z.array(permission),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  revoked: z.boolean(),
});
const createInput = z.object({
  name: z.string().trim().min(1).max(32),
  expiresIn: z.number().int().min(86_400).max(31_536_000).optional(),
  scope: z.object({
    projects: z
      .record(
        slug,
        z
          .array(slug)
          .min(1)
          .transform((envs) => [...new Set(envs)])
      )
      .refine((projects) => Object.keys(projects).length > 0),
  }),
  permissions: z
    .array(permission)
    .optional()
    .transform((values) => [
      ...new Set(values?.length ? values : ["read" as const]),
    ]),
});
const summaryColumns = {
  id: apikey.id,
  name: apikey.name,
  metadata: apikey.metadata,
  permissions: apikey.permissions,
  expiresAt: apikey.expiresAt,
  lastRequest: apikey.lastRequest,
  createdAt: apikey.createdAt,
  enabled: apikey.enabled,
};

const parseStored = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const summarize = (row: {
  id: string;
  name?: string | null;
  metadata: unknown;
  permissions: unknown;
  expiresAt?: Date | null;
  lastRequest?: Date | null;
  createdAt: Date;
  enabled?: boolean | null;
}) => {
  const scope = scopeSchema.safeParse(parseStored(row.metadata));
  const permissions = storedPermissions.safeParse(parseStored(row.permissions));
  return {
    id: row.id,
    name: row.name ?? null,
    scope: scope.success ? scope.data : { projects: {} },
    permissions: permissions.success
      ? permissions.data.secrets.filter(
          (value): value is z.infer<typeof permission> =>
            permission.safeParse(value).success
        )
      : [],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastRequest?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    revoked: row.enabled === false,
  };
};

export const apiKeysRouter = {
  create: userProcedure
    .route({ method: "POST", path: "/api-keys", successStatus: 201 })
    .input(createInput)
    .output(summaryOutput.extend({ key: z.string() }))
    .handler(async ({ context, input }) => {
      const userId = context.principal.user.id;
      const ownedEnvironments = await context.db
        .select({ project: project.slug, environment: environment.slug })
        .from(project)
        .innerJoin(environment, eq(environment.projectId, project.id))
        .where(eq(project.ownerId, userId));
      for (const [projectSlug, envs] of Object.entries(input.scope.projects)) {
        if (
          !envs.every((env) =>
            ownedEnvironments.some(
              (row) => row.project === projectSlug && row.environment === env
            )
          )
        ) {
          throw new ORPCError("BAD_REQUEST");
        }
      }
      const created = await context.auth.api.createApiKey({
        body: {
          userId,
          name: input.name,
          ...(input.expiresIn === undefined
            ? {}
            : { expiresIn: input.expiresIn }),
          metadata: input.scope,
          permissions: { secrets: input.permissions },
        },
      });
      try {
        await recordAuditEvent(context.db, context, "apikey.create", {
          apiKeyId: created.id,
        });
      } catch (error) {
        await context.db.delete(apikey).where(eq(apikey.id, created.id));
        throw error;
      }
      return { ...summarize(created), key: created.key };
    }),
  list: userProcedure
    .route({ method: "GET", path: "/api-keys" })
    .output(z.array(summaryOutput))
    .handler(async ({ context }) => {
      const rows = await context.db
        .select(summaryColumns)
        .from(apikey)
        .where(eq(apikey.referenceId, context.principal.user.id))
        .orderBy(desc(apikey.createdAt));
      return rows.map(summarize);
    }),
  revoke: userProcedure
    .route({ method: "POST", path: "/api-keys/{id}/revoke" })
    .input(z.object({ id: z.string() }))
    .output(summaryOutput)
    .handler(
      async ({ context, input }) =>
        await context.db.transaction(async (transaction) => {
          const owner = and(
            eq(apikey.id, input.id),
            eq(apikey.referenceId, context.principal.user.id)
          );
          const [updated] = await transaction
            .update(apikey)
            .set({ enabled: false, updatedAt: sql`now()` })
            .where(and(owner, sql`${apikey.enabled} IS DISTINCT FROM false`))
            .returning(summaryColumns);
          if (updated) {
            await recordAuditEvent(transaction, context, "apikey.revoke", {
              apiKeyId: updated.id,
            });
            return summarize(updated);
          }
          const [existing] = await transaction
            .select(summaryColumns)
            .from(apikey)
            .where(owner);
          if (!existing) {
            throw new ORPCError("NOT_FOUND");
          }
          return summarize(existing);
        })
    ),
};
