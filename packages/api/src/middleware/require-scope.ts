import { environment, project } from "@jomans-vault/db/schema/vault";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";

import type { Context, KeyPermission, Principal } from "../context";
import { o } from "../index";

interface ScopeInput {
  project: string;
  env?: string;
  permission: KeyPermission;
}

export const requireScope = o
  .$context<Context & { principal: Principal }>()
  .middleware(async ({ context, next }, input: ScopeInput) => {
    const { principal } = context;
    const ownerId =
      principal.type === "user" ? principal.user.id : principal.userId;
    const [ownedProject] = await context.db
      .select()
      .from(project)
      .where(
        and(eq(project.slug, input.project), eq(project.ownerId, ownerId))
      );
    if (!ownedProject) {
      throw new ORPCError("NOT_FOUND");
    }
    if (principal.type === "apiKey") {
      if (!Object.hasOwn(principal.scope.projects, input.project)) {
        throw new ORPCError("FORBIDDEN");
      }
      if (
        input.env === undefined ||
        !principal.scope.projects[input.project]?.includes(input.env)
      ) {
        throw new ORPCError("FORBIDDEN");
      }
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
    if (
      principal.type === "apiKey" &&
      !principal.permissions.includes(input.permission)
    ) {
      throw new ORPCError("FORBIDDEN");
    }
    return await next({
      context: { project: ownedProject, environment: scopedEnvironment },
    });
  });
