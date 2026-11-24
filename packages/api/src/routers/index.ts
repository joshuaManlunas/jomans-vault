import type { RouterClient } from "@orpc/server";

import { userProcedure, publicProcedure } from "../index";
import { environmentsRouter } from "./environments";
import { projectsRouter } from "./projects";
import { secretsRouter } from "./secrets";

export const appRouter = {
  projects: projectsRouter,
  environments: environmentsRouter,
  secrets: secretsRouter,
  healthCheck: publicProcedure
    .route({ method: "GET", path: "/health" })
    .handler(() => "OK"),
  privateData: userProcedure
    .route({ method: "GET", path: "/private-data" })
    .handler(({ context }) => ({
      message: "This is private",
      user: context.principal.user,
    })),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
