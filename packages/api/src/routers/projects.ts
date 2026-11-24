import { generateDek, wrapDek } from "@jomans-vault/crypto";
import { project, projectKey } from "@jomans-vault/db/schema/vault";
import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import * as z from "zod";

import { userProcedure } from "../index";
import { audit } from "../middleware/audit";
import { requireScope } from "../middleware/require-scope";
import { isUniqueViolation, slug } from "./validation";

const name = z.string().trim().min(1).max(100);
const projectOutput = z.object({
  slug: z.string(),
  name: z.string(),
  createdAt: z.date().transform((date) => date.toISOString()),
  updatedAt: z.date().transform((date) => date.toISOString()),
});

const auditTarget = ({ output }: { output: unknown }) => ({
  projectId: z.object({ id: z.string() }).parse(output).id,
});

export const projectsRouter = {
  create: userProcedure
    .route({ method: "POST", path: "/projects", successStatus: 201 })
    .input(z.object({ slug, name }))
    .output(projectOutput)
    .use(audit("project.create", auditTarget))
    .handler(async ({ context, input }) => {
      const wrapped = await wrapDek(generateDek(), context.masterKey);
      let createdProject;
      try {
        [createdProject] = await context.db
          .insert(project)
          .values({ ...input, ownerId: context.principal.user.id })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error, "project_owner_id_slug_unique")) {
          throw new ORPCError("CONFLICT");
        }
        throw error;
      }
      if (!createdProject) {
        throw new ORPCError("INTERNAL_SERVER_ERROR");
      }
      await context.db.insert(projectKey).values({
        projectId: createdProject.id,
        wrappedDek: Buffer.from(wrapped.wrappedDek),
        iv: Buffer.from(wrapped.iv),
        kekVersion: 1,
      });
      return createdProject;
    }),
  list: userProcedure
    .route({ method: "GET", path: "/projects" })
    .output(z.array(projectOutput))
    .handler(
      async ({ context }) =>
        await context.db
          .select()
          .from(project)
          .where(eq(project.ownerId, context.principal.user.id))
          .orderBy(asc(project.slug))
    ),
  rename: userProcedure
    .route({ method: "PATCH", path: "/projects/{project}" })
    .input(z.object({ project: slug, name }))
    .output(projectOutput)
    .use(requireScope, (input) => ({
      project: input.project,
      permission: "read" as const,
    }))
    .handler(async ({ context, input }) => {
      const [renamed] = await context.db
        .update(project)
        .set({ name: input.name })
        .where(eq(project.id, context.project.id))
        .returning();
      if (!renamed) {
        throw new ORPCError("NOT_FOUND");
      }
      return renamed;
    }),
  delete: userProcedure
    .route({
      method: "DELETE",
      path: "/projects/{project}",
      successStatus: 204,
    })
    .input(z.object({ project: slug }))
    .output(
      z.object({ id: z.string() }).transform(() => {
        // A 204 response discards the internal audit target.
      })
    )
    .use(requireScope, (input) => ({
      project: input.project,
      permission: "read" as const,
    }))
    .use(audit("project.delete", auditTarget))
    .handler(async ({ context }) => {
      const [deleted] = await context.db
        .delete(project)
        .where(eq(project.id, context.project.id))
        .returning({ id: project.id });
      if (!deleted) {
        throw new ORPCError("NOT_FOUND");
      }
      return deleted;
    }),
};
