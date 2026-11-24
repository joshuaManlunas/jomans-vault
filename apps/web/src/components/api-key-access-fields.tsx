import { Button } from "@jomans-vault/ui/components/button";
import { Checkbox } from "@jomans-vault/ui/components/checkbox";
import { Label } from "@jomans-vault/ui/components/label";
import { Skeleton } from "@jomans-vault/ui/components/skeleton";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { permissions } from "@/lib/api-key-form";
import { orpc } from "@/utils/orpc";

type Permission = (typeof permissions)[number];

export const useApiKeyPicker = (userId: string, enabled: boolean) => {
  const projects = useQuery(
    orpc.projects.list.queryOptions({
      queryKey: [...orpc.projects.list.key(), { userId }],
      enabled,
    })
  );
  const projectList = projects.data ?? [];
  const environments = useQueries({
    queries: projectList.map((project) =>
      orpc.environments.list.queryOptions({
        input: { project: project.slug },
        queryKey: [
          ...orpc.environments.list.key({ input: { project: project.slug } }),
          { userId },
        ],
        enabled,
      })
    ),
  });
  const pickerFailed =
    projects.isError || environments.some((query) => query.isError);
  const pickerLoading =
    projects.isPending || environments.some((query) => query.isPending);
  const hasEnvironments = environments.some(
    (query) => (query.data?.length ?? 0) > 0
  );
  const pickerReady = !pickerFailed && !pickerLoading && hasEnvironments;

  const refreshPicker = async () => {
    await projects.refetch();
    await Promise.all(environments.map((query) => query.refetch()));
  };

  return {
    projectList,
    environments,
    pickerFailed,
    pickerLoading,
    hasEnvironments,
    pickerReady,
    refreshPicker,
  };
};

export const ApiKeyScopeField = ({
  value,
  onChange,
  errors,
  disabled,
  idPrefix,
  picker,
}: {
  value: Record<string, string[]>;
  onChange: (value: Record<string, string[]>) => void;
  errors: readonly (string | undefined)[];
  disabled: boolean;
  idPrefix: string;
  picker: ReturnType<typeof useApiKeyPicker>;
}) => {
  const {
    pickerFailed,
    pickerLoading,
    hasEnvironments,
    pickerReady,
    projectList,
    environments,
    refreshPicker,
  } = picker;
  return (
    <fieldset
      disabled={disabled}
      aria-describedby={`${idPrefix}-scope-errors`}
      className="flex min-w-0 flex-col gap-3"
    >
      <legend className="mb-2 font-medium">Scope</legend>
      {pickerFailed && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-destructive">
            Couldn&apos;t load your projects and environments.
          </p>
          <Button type="button" variant="outline" onClick={refreshPicker}>
            Retry
          </Button>
        </div>
      )}
      {!pickerFailed && pickerLoading && (
        <output aria-label="Loading scope">
          <Skeleton className="h-16 w-full" />
        </output>
      )}
      {!pickerFailed && !pickerLoading && !hasEnvironments && (
        <p>
          Create a project and an environment before creating an API key.{" "}
          <Link to="/projects" className="underline">
            Go to projects
          </Link>
        </p>
      )}
      {pickerReady &&
        projectList.map((project, index) => (
          <fieldset
            key={project.slug}
            className="flex min-w-0 flex-col gap-2 border p-3"
          >
            <legend className="px-1 wrap-anywhere">{project.name}</legend>
            {environments[index]?.data?.length === 0 && (
              <p className="text-muted-foreground">No environments yet</p>
            )}
            {environments[index]?.data?.map((env) => (
              <Label
                key={env.slug}
                className="flex items-center gap-2 wrap-anywhere"
              >
                <Checkbox
                  checked={value[project.slug]?.includes(env.slug) ?? false}
                  disabled={disabled}
                  aria-invalid={errors.length > 0}
                  aria-describedby={`${idPrefix}-scope-errors`}
                  onCheckedChange={(checked) => {
                    const selected = value[project.slug] ?? [];
                    onChange({
                      ...value,
                      [project.slug]: checked
                        ? [...selected, env.slug]
                        : selected.filter((slug) => slug !== env.slug),
                    });
                  }}
                />
                {env.slug}
              </Label>
            ))}
          </fieldset>
        ))}
      <div id={`${idPrefix}-scope-errors`} className="text-destructive">
        {errors.map((error) => (
          <p key={error}>{error}</p>
        ))}
      </div>
    </fieldset>
  );
};

export const ApiKeyPermissionsField = ({
  value,
  onChange,
  errors,
  disabled,
  idPrefix,
}: {
  value: Permission[];
  onChange: (value: Permission[]) => void;
  errors: readonly (string | undefined)[];
  disabled: boolean;
  idPrefix: string;
}) => (
  <fieldset
    aria-describedby={`${idPrefix}-permissions-errors`}
    className="flex flex-col gap-3"
  >
    <legend className="mb-2 font-medium">Permissions</legend>
    {permissions.map((permission) => (
      <div key={permission} className="flex flex-col gap-1">
        <Label className="flex items-center gap-2">
          <Checkbox
            checked={value.includes(permission)}
            disabled={disabled}
            aria-invalid={errors.length > 0}
            aria-describedby={`${idPrefix}-permissions-errors`}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...value, permission]
                  : value.filter((item) => item !== permission)
              )
            }
          />
          {permission}
        </Label>
        {(permission === "reveal" || permission === "inject") && (
          <p className="text-muted-foreground pl-6">
            Plaintext access —{" "}
            {permission === "reveal"
              ? "returns secret values."
              : "returns all values in an environment for running commands."}
          </p>
        )}
      </div>
    ))}
    <div id={`${idPrefix}-permissions-errors`} className="text-destructive">
      {errors.map((error) => (
        <p key={error}>{error}</p>
      ))}
    </div>
  </fieldset>
);
