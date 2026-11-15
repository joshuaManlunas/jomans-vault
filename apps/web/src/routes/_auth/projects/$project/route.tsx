import { slug } from "@jomans-vault/api/routers/validation";
import { Button } from "@jomans-vault/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@jomans-vault/ui/components/empty";
import { Label } from "@jomans-vault/ui/components/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@jomans-vault/ui/components/select";
import { Skeleton } from "@jomans-vault/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";

import { NewEnvironmentDialog } from "@/components/new-environment-dialog";
import {
  ProjectPageContext,
  isProjectNotFound,
  retryProjectQuery,
  useProjectSecrets,
} from "@/lib/project-page";
import { orpc } from "@/utils/orpc";

const ProjectNotFound = () => (
  <Empty>
    <EmptyHeader>
      <EmptyTitle>Project not found</EmptyTitle>
      <EmptyDescription>
        This project or environment doesn&apos;t exist, or you don&apos;t have
        access to it.
      </EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <Link to="/projects" className="underline">
        Back to projects
      </Link>
    </EmptyContent>
  </Empty>
);

const ProjectLayout = ({ project, env }: { project: string; env?: string }) => {
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();
  const userId = session.user.id;
  const projects = useQuery(
    orpc.projects.list.queryOptions({
      queryKey: [...orpc.projects.list.key(), { userId }],
      retry: retryProjectQuery,
    })
  );
  const currentProject = projects.data?.find((item) => item.slug === project);
  const environments = useQuery(
    orpc.environments.list.queryOptions({
      input: { project },
      queryKey: [
        ...orpc.environments.list.key({ input: { project } }),
        { userId },
      ],
      enabled: !!currentProject,
      retry: retryProjectQuery,
    })
  );
  const hasEnvironment =
    environments.data?.some((item) => item.slug === env) ?? false;
  const secrets = useProjectSecrets(
    project,
    env ?? "",
    userId,
    hasEnvironment && !!currentProject
  );

  if (
    isProjectNotFound(environments.error) ||
    isProjectNotFound(secrets.error) ||
    (projects.isSuccess && !currentProject) ||
    (env !== undefined && environments.isSuccess && !hasEnvironment)
  ) {
    return <ProjectNotFound />;
  }
  if (projects.isError || environments.isError) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p role="alert">Couldn&apos;t load this project.</p>
        <Button
          variant="outline"
          onClick={() => {
            if (projects.isError) {
              projects.refetch();
            }
            if (environments.isError) {
              environments.refetch();
            }
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (projects.isPending || environments.isPending || !currentProject) {
    return (
      <output aria-label="Loading project" className="flex flex-col gap-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </output>
    );
  }

  return (
    <ProjectPageContext value={{ environments: environments.data, secrets }}>
      <Link to="/projects" className="w-fit underline">
        Back to projects
      </Link>
      <h1 className="text-2xl font-semibold wrap-anywhere">
        {currentProject.name}
      </h1>
      <NewEnvironmentDialog key={userId} project={project}>
        {environments.data.length > 0 && (
          <div className="flex flex-col items-start gap-2">
            <Label htmlFor="environment">Environment</Label>
            <Select
              value={env ?? null}
              onValueChange={(value) => {
                if (value && value !== env) {
                  navigate({
                    to: "/projects/$project/$env",
                    params: { project, env: value },
                  });
                }
              }}
            >
              <SelectTrigger id="environment">
                <SelectValue placeholder="Choose an environment" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {environments.data.map((item) => (
                    <SelectItem key={item.slug} value={item.slug}>
                      {item.slug}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        )}
        <Outlet />
      </NewEnvironmentDialog>
    </ProjectPageContext>
  );
};

const ProjectPage = () => {
  const { project, env } = useParams({ strict: false });
  const valid =
    slug.safeParse(project).success &&
    (env === undefined || slug.safeParse(env).success);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      {valid && project ? (
        <ProjectLayout key={project} project={project} env={env} />
      ) : (
        <ProjectNotFound />
      )}
    </main>
  );
};

export const Route = createFileRoute("/_auth/projects/$project")({
  component: ProjectPage,
});
