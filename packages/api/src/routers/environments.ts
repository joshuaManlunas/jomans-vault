import { environment } from "@jomans-vault/db/schema/vault";
import { ORPCError } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import * as z from "zod";

import { authedProcedure } from "../index";
import { audit } from "../middleware/audit";
import { requireScope } from "../middleware/require-scope";
import { isUniqueViolation, slug } from "./validation";

const environmentOutput = z.object({
  slug: z.string(),
  createdAt: z.date().transform((date) => date.toISOString()),
});
const auditTarget = ({ output }: { output: unknown }) => {
  const { id, projectId } = z
    .object({ id: z.string(), projectId: z.string() })
    .parse(output);
  return { projectId, environmentId: id };
};

export const environmentsRouter = {
  create: authedProcedure
    .route({
      method: "POST",
      path: "/projects/{project}/envs",
      successStatus: 201,
    })
    .input(z.object({ project: slug, slug }))
    .output(environmentOutput)
    .use(requireScope, (input) => ({ project: input.project }))
    .use(audit("environment.create", auditTarget))
    .handler(async ({ context, input }) => {
      let createdEnvironment;
      try {
        [createdEnvironment] = await context.db
          .insert(environment)
          .values({ projectId: context.project.id, slug: input.slug })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error, "environment_project_id_slug_unique")) {
          throw new ORPCError("CONFLICT");
        }
        throw error;
      }
      if (!createdEnvironment) {
        throw new ORPCError("INTERNAL_SERVER_ERROR");
      }
      return createdEnvironment;
    }),
  list: authedProcedure
    .route({ method: "GET", path: "/projects/{project}/envs" })
    .input(z.object({ project: slug }))
    .output(z.array(environmentOutput))
    .use(requireScope, (input) => ({ project: input.project }))
    .handler(
      async ({ context }) =>
        await context.db
          .select()
          .from(environment)
          .where(eq(environment.projectId, context.project.id))
          .orderBy(asc(environment.slug))
    ),
  delete: authedProcedure
    .route({
      method: "DELETE",
      path: "/projects/{project}/envs/{env}",
      successStatus: 204,
    })
    .input(z.object({ project: slug, env: slug }))
    .output(
      z.object({ id: z.string(), projectId: z.string() }).transform(() => {
        // A 204 response discards the internal audit target.
      })
    )
    .use(requireScope, (input) => ({ project: input.project, env: input.env }))
    .use(audit("environment.delete", auditTarget))
    .handler(async ({ context }) => {
      if (!context.environment) {
        throw new ORPCError("NOT_FOUND");
      }
      const [deleted] = await context.db
        .delete(environment)
        .where(eq(environment.id, context.environment.id))
        .returning({ id: environment.id, projectId: environment.projectId });
      if (!deleted) {
        throw new ORPCError("NOT_FOUND");
      }
      return deleted;
    }),
};
