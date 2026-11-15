import { Badge } from "@jomans-vault/ui/components/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@jomans-vault/ui/components/table";
import { createFileRoute } from "@tanstack/react-router";

import { NewSecretDialog } from "@/components/new-secret-dialog";
import { SecretValue } from "@/components/secret-value";
import { useProjectPage } from "@/lib/project-page";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const EnvironmentSecrets = () => {
  const { secrets } = useProjectPage();
  const { project, env } = Route.useParams();
  if (secrets.isPending) {
    return (
      <output aria-label="Loading secrets" className="flex flex-col gap-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </output>
    );
  }
  if (secrets.isError) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p role="alert">Couldn&apos;t load this environment&apos;s secrets.</p>
        <Button variant="outline" onClick={() => secrets.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <NewSecretDialog
      key={`${project}/${env}`}
      project={project}
      env={env}
      existingKeys={secrets.data.map((secret) => secret.key)}
    >
      {secrets.data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No secrets yet</EmptyTitle>
            <EmptyDescription>
              This environment has no secrets.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <DialogTrigger render={<Button />}>Add secret</DialogTrigger>
          </EmptyContent>
        </Empty>
      ) : (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Last update</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {secrets.data.map((secret) => (
              <TableRow key={secret.key}>
                <TableCell className="font-mono wrap-anywhere whitespace-normal">
                  {secret.key}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{secret.kind}</Badge>
                </TableCell>
                <TableCell>{secret.version}</TableCell>
                <TableCell className="whitespace-normal">
                  <time dateTime={secret.updatedAt}>
                    {dateFormatter.format(new Date(secret.updatedAt))}
                  </time>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <SecretValue
                    key={`${project}/${env}/${secret.key}`}
                    project={project}
                    env={env}
                    secretKey={secret.key}
                    version={secret.version}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </NewSecretDialog>
  );
};

export const Route = createFileRoute("/_auth/projects/$project/$env")({
  component: EnvironmentSecrets,
});
