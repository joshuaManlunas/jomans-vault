import { Button } from "@jomans-vault/ui/components/button";
import { DialogTrigger } from "@jomans-vault/ui/components/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@jomans-vault/ui/components/empty";
import { Navigate, createFileRoute } from "@tanstack/react-router";

import { useProjectPage } from "@/lib/project-page";

const ProjectIndex = () => {
  const { project } = Route.useParams();
  const { environments } = useProjectPage();
  const [firstEnvironment] = environments;
  if (firstEnvironment) {
    return (
      <Navigate
        to="/projects/$project/$env"
        params={{ project, env: firstEnvironment.slug }}
        replace
      />
    );
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No environments yet</EmptyTitle>
        <EmptyDescription>
          Add an environment to organize this project&apos;s secrets.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <DialogTrigger render={<Button />}>Add environment</DialogTrigger>
      </EmptyContent>
    </Empty>
  );
};

export const Route = createFileRoute("/_auth/projects/$project/")({
  component: ProjectIndex,
});
