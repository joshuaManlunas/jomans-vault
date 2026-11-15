import type { RouterClient } from "@orpc/server";

import { authedProcedure, publicProcedure } from "../index";

export const appRouter = {
  healthCheck: publicProcedure
    .route({ method: "GET", path: "/health" })
    .handler(() => "OK"),
  privateData: authedProcedure
    .route({ method: "GET", path: "/private-data" })
    .handler(({ context }) => ({
      message: "This is private",
      user: context.principal.user,
    })),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
