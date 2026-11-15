import { Button } from "@jomans-vault/ui/components/button";
import { DialogTrigger } from "@jomans-vault/ui/components/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@jomans-vault/ui/components/empty";
import { Skeleton } from "@jomans-vault/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { NewProjectDialog } from "@/components/new-project-dialog";
import { orpc } from "@/utils/orpc";

const ProjectsList = () => {
  const projects = useQuery(orpc.projects.list.queryOptions());

  if (projects.isPending) {
    return (
      <output aria-label="Loading projects" className="flex flex-col gap-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </output>
    );
  }

  if (projects.isError) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p role="alert">Couldn&apos;t load your projects.</p>
        <Button variant="outline" onClick={() => projects.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (projects.data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>
            Create a project to start organizing your vault.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <DialogTrigger render={<Button />}>New project</DialogTrigger>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <ul className="divide-y border">
      {projects.data.map((project) => (
        <li key={project.slug} className="flex flex-col gap-1 p-4">
          <span className="font-medium">{project.name}</span>
          <span className="text-muted-foreground text-sm">{project.slug}</span>
        </li>
      ))}
    </ul>
  );
};

const ProjectsPage = () => (
  <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
    <NewProjectDialog>
      <ProjectsList />
    </NewProjectDialog>
  </main>
);

export const Route = createFileRoute("/_auth/projects/")({
  beforeLoad: ({ context }) => {
    context.queryClient.removeQueries({ queryKey: orpc.projects.list.key() });
  },
  component: ProjectsPage,
});
