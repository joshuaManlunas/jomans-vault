import { ORPCError } from "@orpc/client";
import { useQuery } from "@tanstack/react-query";
import { createContext, use } from "react";

import { orpc } from "@/utils/orpc";

export const isProjectNotFound = (error: unknown): boolean =>
  error instanceof ORPCError && error.code === "NOT_FOUND";

export const retryProjectQuery = (
  failureCount: number,
  error: unknown
): boolean => !isProjectNotFound(error) && failureCount < 3;

export const useProjectSecrets = (
  project: string,
  env: string,
  userId: string,
  enabled: boolean
) =>
  useQuery(
    orpc.secrets.list.queryOptions({
      input: { project, env },
      queryKey: [
        ...orpc.secrets.list.key({ input: { project, env } }),
        { userId },
      ],
      enabled,
      retry: retryProjectQuery,
    })
  );

export const ProjectPageContext = createContext<{
  environments: { slug: string }[];
  secrets: ReturnType<typeof useProjectSecrets>;
} | null>(null);

export const useProjectPage = () => {
  const context = use(ProjectPageContext);
  if (!context) {
    throw new Error("Project page context is missing");
  }
  return context;
};
