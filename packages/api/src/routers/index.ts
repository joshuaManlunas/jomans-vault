import type { RouterClient } from "@orpc/server";

import { authedProcedure, publicProcedure } from "../index";
import { environmentsRouter } from "./environments";
import { projectsRouter } from "./projects";

export const appRouter = {
  projects: projectsRouter,
  environments: environmentsRouter,
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
