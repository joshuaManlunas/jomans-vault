import { Badge } from "@jomans-vault/ui/components/badge";
import { Button } from "@jomans-vault/ui/components/button";
import {
  Empty,
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

import { useProjectPage } from "@/lib/project-page";

const MASK = "••••••••";
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const EnvironmentSecrets = () => {
  const { secrets } = useProjectPage();
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
  if (secrets.data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No secrets yet</EmptyTitle>
          <EmptyDescription>This environment has no secrets.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Table>
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
            <TableCell className="font-mono">{secret.key}</TableCell>
            <TableCell>
              <Badge variant="secondary">{secret.kind}</Badge>
            </TableCell>
            <TableCell>{secret.version}</TableCell>
            <TableCell>
              <time dateTime={secret.updatedAt}>
                {dateFormatter.format(new Date(secret.updatedAt))}
              </time>
            </TableCell>
            <TableCell>
              <span aria-hidden="true">{MASK}</span>
              <span className="sr-only">Hidden value</span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

export const Route = createFileRoute("/_auth/projects/$project/$env")({
  component: EnvironmentSecrets,
});
