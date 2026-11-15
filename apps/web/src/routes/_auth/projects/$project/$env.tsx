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
import { useRef, useState } from "react";

import { DeleteSecretDialog } from "@/components/delete-secret-dialog";
import { EditSecretDialog } from "@/components/edit-secret-dialog";
import { NewSecretDialog } from "@/components/new-secret-dialog";
import { SecretRowActions } from "@/components/secret-row-actions";
import { SecretValue } from "@/components/secret-value";
import { useProjectPage } from "@/lib/project-page";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const EnvironmentSecrets = () => {
  const { secrets } = useProjectPage();
  const { project, env } = Route.useParams();
  const addButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<{
    target: { key: string; version: number };
    opener: HTMLElement;
  } | null>(null);
  const [deleting, setDeleting] = useState<{
    target: { key: string };
    opener: HTMLElement;
  } | null>(null);
  if (secrets.isPending) {
    return (
      <output aria-label="Loading secrets" className="flex flex-col gap-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </output>
    );
  }
  if (secrets.isError && !secrets.data) {
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
      addButtonRef={addButton}
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
        <Table className="min-w-160 table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-1/4">Key</TableHead>
              <TableHead className="w-20">Kind</TableHead>
              <TableHead className="w-16">Version</TableHead>
              <TableHead className="w-36">Last update</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="w-14">
                <span className="sr-only">Actions</span>
              </TableHead>
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
                    updatedAt={secret.updatedAt}
                  />
                </TableCell>
                <TableCell>
                  <SecretRowActions
                    secretKey={secret.key}
                    onEdit={(opener) =>
                      setEditing({
                        target: { key: secret.key, version: secret.version },
                        opener,
                      })
                    }
                    onDelete={(opener) =>
                      setDeleting({ target: { key: secret.key }, opener })
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <EditSecretDialog
        project={project}
        env={env}
        target={editing?.target ?? null}
        opener={editing?.opener ?? null}
        onClose={() => setEditing(null)}
        addButton={addButton}
      />
      <DeleteSecretDialog
        project={project}
        env={env}
        target={deleting?.target ?? null}
        opener={deleting?.opener ?? null}
        onClose={() => setDeleting(null)}
        addButton={addButton}
      />
    </NewSecretDialog>
  );
};

const EnvironmentPage = () => {
  const { project, env } = Route.useParams();
  return <EnvironmentSecrets key={`${project}/${env}`} />;
};

export const Route = createFileRoute("/_auth/projects/$project/$env")({
  component: EnvironmentPage,
});
