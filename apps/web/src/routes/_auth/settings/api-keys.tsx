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
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { NewApiKeyDialog } from "@/components/new-api-key-dialog";
import { RevokeApiKeyDialog } from "@/components/revoke-api-key-dialog";
import { apiKeyStatus } from "@/lib/api-key-form";
import { dateFormatter } from "@/lib/date-format";
import { orpc } from "@/utils/orpc";

const statusLabels = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
} as const;

const ApiKeysList = ({
  headerButton,
}: {
  headerButton: RefObject<HTMLButtonElement | null>;
}) => {
  const { session } = Route.useRouteContext();
  const keys = useQuery(
    orpc.apiKeys.list.queryOptions({
      queryKey: [...orpc.apiKeys.list.key(), { userId: session.user.id }],
    })
  );
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [revoking, setRevoking] = useState<{
    target: { id: string; name: string | null };
    opener: HTMLElement;
    open: boolean;
    session: number;
  } | null>(null);

  if (keys.isPending) {
    return (
      <output aria-label="Loading API keys" className="flex flex-col gap-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </output>
    );
  }
  if (keys.isError) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p role="alert">Couldn&apos;t load your API keys.</p>
        <Button variant="outline" onClick={() => keys.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <>
      {keys.data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No API keys yet</EmptyTitle>
            <EmptyDescription>
              Create a scoped key for an agent or API client.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <DialogTrigger render={<Button />}>New API key</DialogTrigger>
          </EmptyContent>
        </Empty>
      ) : (
        <Table className="min-w-200 table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-24">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.data.map((key) => {
              const name = key.name ?? "Unnamed key";
              const status = apiKeyStatus(key, now);
              return (
                <TableRow key={key.id}>
                  <TableCell className="wrap-anywhere whitespace-normal">
                    {name}
                  </TableCell>
                  <TableCell className="wrap-anywhere whitespace-normal">
                    {Object.entries(key.scope.projects).map(
                      ([project, envs]) => (
                        <p key={project}>
                          {project}: {envs.join(", ")}
                        </p>
                      )
                    )}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {key.permissions.join(", ")}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {key.expiresAt ? (
                      <time dateTime={key.expiresAt}>
                        {dateFormatter.format(new Date(key.expiresAt))}
                      </time>
                    ) : (
                      "Never"
                    )}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {key.lastUsedAt ? (
                      <time dateTime={key.lastUsedAt}>
                        {dateFormatter.format(new Date(key.lastUsedAt))}
                      </time>
                    ) : (
                      "Never used"
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={status === "active" ? "secondary" : "outline"}
                    >
                      {statusLabels[status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {status === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Revoke ${name}`}
                        onClick={(event) => {
                          const opener = event.currentTarget;
                          setRevoking((current) => ({
                            target: { id: key.id, name: key.name },
                            opener,
                            open: true,
                            session: (current?.session ?? 0) + 1,
                          }));
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {revoking && (
        <RevokeApiKeyDialog
          key={revoking.session}
          {...revoking}
          headerButton={headerButton}
          onClose={() =>
            setRevoking((current) =>
              current ? { ...current, open: false } : null
            )
          }
        />
      )}
    </>
  );
};

const ApiKeysPage = () => {
  const { session } = Route.useRouteContext();
  const headerButton = useRef<HTMLButtonElement>(null);

  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 p-6">
      <NewApiKeyDialog
        key={session.user.id}
        userId={session.user.id}
        headerButton={headerButton}
      >
        <ApiKeysList headerButton={headerButton} />
      </NewApiKeyDialog>
    </main>
  );
};

export const Route = createFileRoute("/_auth/settings/api-keys")({
  component: ApiKeysPage,
});
