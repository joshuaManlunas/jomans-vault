import { project } from "@jomans-vault/db/schema/vault";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";

import type { Context, Principal } from "../context";
import { o } from "../index";

export const requireScope = o
  .$context<Context & { principal: Principal }>()
  .middleware(async ({ context, next }, input: { project: string }) => {
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
    return await next({ context: { project: ownedProject } });
  });
