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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@jomans-vault/ui/components/table";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import type { AuditFilters } from "@/lib/audit-log";
import {
  actorFilterOptions,
  actorLabel,
  auditListInput,
  environmentLabel,
  keyNames,
  projectLabel,
  recordedLabel,
  targetLabel,
} from "@/lib/audit-log";
import { dateFormatter } from "@/lib/date-format";
import { orpc } from "@/utils/orpc";

const AuditFilter = ({
  id,
  label,
  options,
  value,
  onValueChange,
}: {
  id: string;
  label: string;
  options: { value: string | null; label: string }[];
  value: string | null;
  onValueChange: (value: string | null) => void;
}) => (
  <div className="flex min-w-0 flex-col items-start gap-2">
    <Label htmlFor={id}>{label}</Label>
    <Select items={options} value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id} className="max-w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value === null ? "all" : `value-${option.value}`}
              value={option.value}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  </div>
);

const AuditLog = ({ userId }: { userId: string }) => {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<AuditFilters>({
    project: null,
    actor: null,
  });
  const events = useInfiniteQuery(
    orpc.audit.list.infiniteOptions({
      input: (cursor: string | undefined) => auditListInput(filters, cursor),
      queryKey: [...orpc.audit.list.key(), { userId, ...filters }],
      initialPageParam: undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      staleTime: 0,
    })
  );
  const keys = useQuery(
    orpc.apiKeys.list.queryOptions({
      queryKey: [...orpc.apiKeys.list.key(), { userId }],
    })
  );
  const projects = useQuery(
    orpc.projects.list.queryOptions({
      queryKey: [...orpc.projects.list.key(), { userId }],
    })
  );
  const changeFilters = (next: AuditFilters) => {
    if (next.project === filters.project && next.actor === filters.actor) {
      return;
    }
    // Revisiting a filter combination must start at its newest page again.
    queryClient.removeQueries({
      queryKey: [...orpc.audit.list.key(), { userId, ...next }],
      exact: true,
    });
    setFilters(next);
  };
  const queries = [events, keys, projects];
  const hasInitialError = queries.some(
    (query) => query.isError && query.data === undefined
  );
  const isLoading = queries.some((query) => query.isPending);
  const rows = events.data?.pages.flatMap((page) => page.events) ?? [];
  const names = keyNames(keys.data ?? []);
  const hasFilters = filters.project !== null || filters.actor !== null;

  let content: ReactNode;
  if (hasInitialError) {
    content = (
      <div className="flex flex-col items-start gap-4">
        <p role="alert">Couldn&apos;t load the audit log.</p>
        <Button
          variant="outline"
          onClick={() => {
            for (const query of queries) {
              if (query.isError) {
                query.refetch();
              }
            }
          }}
        >
          Retry
        </Button>
      </div>
    );
  } else if (isLoading) {
    content = (
      <output aria-label="Loading audit events" className="flex flex-col gap-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </output>
    );
  } else if (rows.length === 0) {
    content = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            {hasFilters ? "No matching events" : "No activity yet"}
          </EmptyTitle>
          <EmptyDescription>
            {hasFilters
              ? "No events match these filters."
              : "Actions on your projects, secrets and API keys will appear here."}
          </EmptyDescription>
        </EmptyHeader>
        {hasFilters && (
          <EmptyContent>
            <Button
              variant="outline"
              onClick={() => changeFilters({ project: null, actor: null })}
            >
              Clear filters
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );
  } else {
    content = (
      <>
        <Table className="min-w-240 table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Environment</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>User agent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="wrap-anywhere whitespace-normal">
                  <time dateTime={event.createdAt}>
                    {dateFormatter.format(new Date(event.createdAt))}
                  </time>
                </TableCell>
                <TableCell className="font-mono wrap-anywhere whitespace-normal">
                  {event.action}
                </TableCell>
                <TableCell className="wrap-anywhere whitespace-normal">
                  {actorLabel(event, userId, names)}
                </TableCell>
                <TableCell className="wrap-anywhere whitespace-normal">
                  {targetLabel(event, names)}
                </TableCell>
                <TableCell className="wrap-anywhere whitespace-normal">
                  {projectLabel(event)}
                </TableCell>
                <TableCell className="wrap-anywhere whitespace-normal">
                  {environmentLabel(event)}
                </TableCell>
                <TableCell className="wrap-anywhere whitespace-normal">
                  {recordedLabel(event.ip)}
                </TableCell>
                <TableCell className="wrap-anywhere whitespace-normal">
                  {recordedLabel(event.userAgent)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {events.isFetchNextPageError && (
          <p role="alert">Couldn&apos;t load older events.</p>
        )}
        {events.hasNextPage && (
          <Button
            className="self-start"
            variant="outline"
            disabled={events.isFetching}
            onClick={() => events.fetchNextPage()}
          >
            {events.isFetchingNextPage ? "Loading..." : "Load older"}
          </Button>
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap gap-4">
        <AuditFilter
          id="audit-project"
          label="Project"
          value={filters.project}
          onValueChange={(project) => changeFilters({ ...filters, project })}
          options={[
            { value: null, label: "All projects" },
            ...(projects.data ?? []).map((project) => ({
              value: project.slug,
              label: project.name,
            })),
          ]}
        />
        <AuditFilter
          id="audit-actor"
          label="Actor"
          value={filters.actor}
          onValueChange={(actor) => changeFilters({ ...filters, actor })}
          options={[
            { value: null, label: "All actors" },
            ...actorFilterOptions(keys.data ?? []),
          ]}
        />
      </div>
      {content}
    </>
  );
};

const AuditPage = () => {
  const { session } = Route.useRouteContext();
  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <AuditLog key={session.user.id} userId={session.user.id} />
    </main>
  );
};

export const Route = createFileRoute("/_auth/audit")({
  component: AuditPage,
});
