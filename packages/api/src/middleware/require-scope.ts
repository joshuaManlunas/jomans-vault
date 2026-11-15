import { environment, project } from "@jomans-vault/db/schema/vault";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";

import type { Context, Principal } from "../context";
import { o } from "../index";

interface ScopeInput {
  project: string;
  env?: string;
}

export const requireScope = o
  .$context<Context & { principal: Principal }>()
  .middleware(async ({ context, next }, input: ScopeInput) => {
    const [ownedProject] = await context.db
      .select()
      .from(project)
      .where(
        and(
          eq(project.slug, input.project),
          eq(project.ownerId, context.principal.user.id)
        )
      );
    if (!ownedProject) {
      throw new ORPCError("NOT_FOUND");
    }
    let scopedEnvironment = null;
    if (input.env !== undefined) {
      const [found] = await context.db
        .select()
        .from(environment)
        .where(
          and(
            eq(environment.projectId, ownedProject.id),
            eq(environment.slug, input.env)
          )
        );
      if (!found) {
        throw new ORPCError("NOT_FOUND");
      }
      scopedEnvironment = found;
    }
    return await next({
      context: { project: ownedProject, environment: scopedEnvironment },
    });
  });
