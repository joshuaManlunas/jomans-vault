import { apikey } from "@jomans-vault/db/schema/auth";
import {
  auditEvent,
  environment,
  project,
  secret,
} from "@jomans-vault/db/schema/vault";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import * as z from "zod";

import { userProcedure } from "../index";
import { slug } from "./validation";

const cursorSchema = z
  .object({
    createdAt: z.iso
      .datetime({ precision: 6 })
      .refine((value) => !value.startsWith("0000-")),
    id: z
      .string()
      .min(1)
      .refine((value) => !value.includes("\0")),
  })
  .strict();
const base64urlPattern = /^[A-Za-z0-9_-]+$/u;
const decodeCursor = (value: string) => {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (
      !base64urlPattern.test(value) ||
      decoded.toString("base64url") !== value
    ) {
      throw new Error("Invalid cursor encoding");
    }
    return cursorSchema.parse(JSON.parse(decoded.toString("utf-8")));
  } catch {
    throw new ORPCError("BAD_REQUEST");
  }
};
const eventOutput = z.object({
  id: z.string(),
  action: z.string(),
  actorType: z.string(),
  actorId: z.string(),
  projectId: z.string().nullable(),
  projectSlug: z.string().nullable(),
  environmentId: z.string().nullable(),
  environmentSlug: z.string().nullable(),
  secretId: z.string().nullable(),
  secretKey: z.string().nullable(),
  apiKeyId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
});

export const auditRouter = {
  list: userProcedure
    .route({ method: "GET", path: "/audit" })
    .input(
      z.object({
        project: slug.optional(),
        actor: z.string().min(1).max(255).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
    )
    .output(
      z.object({
        events: z.array(eventOutput),
        nextCursor: z.string().nullable(),
      })
    )
    .handler(async ({ context, input }) => {
      const userId = context.principal.user.id;
      const cursor =
        input.cursor === undefined ? undefined : decodeCursor(input.cursor);
      const ownedKeys = context.db
        .select({ id: apikey.id })
        .from(apikey)
        .where(eq(apikey.referenceId, userId));
      const userActor = and(
        eq(auditEvent.actorType, "user"),
        eq(auditEvent.actorId, userId)
      );
      const keyActor = and(
        eq(auditEvent.actorType, "apiKey"),
        inArray(auditEvent.actorId, ownedKeys)
      );
      let actorFilter = userActor;
      if (input.actor !== undefined && input.actor !== "user") {
        actorFilter = and(
          eq(auditEvent.actorType, "apiKey"),
          eq(auditEvent.actorId, input.actor)
        );
      }
      const rows = await context.db
        .select({
          id: auditEvent.id,
          action: auditEvent.action,
          actorType: auditEvent.actorType,
          actorId: auditEvent.actorId,
          projectId: auditEvent.projectId,
          projectSlug: project.slug,
          environmentId: auditEvent.environmentId,
          environmentSlug: environment.slug,
          secretId: auditEvent.secretId,
          secretKey: secret.key,
          apiKeyId: auditEvent.apiKeyId,
          ip: auditEvent.ip,
          userAgent: auditEvent.userAgent,
          // Keep all six fractional digits for both output and cursor comparisons.
          createdAt: sql<string>`to_char(${auditEvent.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(auditEvent)
        .leftJoin(project, eq(project.id, auditEvent.projectId))
        .leftJoin(environment, eq(environment.id, auditEvent.environmentId))
        .leftJoin(secret, eq(secret.id, auditEvent.secretId))
        .where(
          and(
            or(
              eq(project.ownerId, userId),
              userActor,
              keyActor,
              inArray(auditEvent.apiKeyId, ownedKeys)
            ),
            input.project === undefined
              ? undefined
              : and(
                  eq(project.ownerId, userId),
                  eq(project.slug, input.project)
                ),
            input.actor === undefined ? undefined : actorFilter,
            cursor === undefined
              ? undefined
              : sql`(${auditEvent.createdAt}, ${auditEvent.id}) < (${cursor.createdAt}::timestamp, ${cursor.id}::text)`
          )
        )
        .orderBy(desc(auditEvent.createdAt), desc(auditEvent.id))
        .limit(input.limit + 1);
      const events = rows.slice(0, input.limit);
      const last = events.at(-1);
      const nextCursor =
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({ createdAt: last.createdAt, id: last.id })
            ).toString("base64url")
          : null;
      return { events, nextCursor };
    }),
};
