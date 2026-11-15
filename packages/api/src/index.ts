import { ORPCError, os } from "@orpc/server";

import type { Context } from "./context";

export const o = os.$context<Context>();

export const publicProcedure = o;

const requireAuth = o.middleware(async ({ context, next }) => {
  if (!context.principal) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return await next({
    context: {
      principal: context.principal,
    },
  });
});

export const authedProcedure = publicProcedure.use(requireAuth);
