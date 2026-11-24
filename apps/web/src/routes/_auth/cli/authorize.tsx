import { Button } from "@jomans-vault/ui/components/button";
import { Skeleton } from "@jomans-vault/ui/components/skeleton";
import { ORPCError } from "@orpc/client";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  ApiKeyPermissionsField,
  ApiKeyScopeField,
  useApiKeyPicker,
} from "@/components/api-key-access-fields";
import { buildScope, suggestedSelection } from "@/lib/api-key-form";
import type { permissions } from "@/lib/api-key-form";
import { dateFormatter } from "@/lib/date-format";
import { isProjectNotFound, retryProjectQuery } from "@/lib/project-page";
import { client, orpc } from "@/utils/orpc";

type Permission = (typeof permissions)[number];
type LoginRequest = Awaited<ReturnType<typeof client.loginRequests.read>>;
type Outcome = LoginRequest["status"] | "approved-now" | "not-found";

const outcomes = {
  "approved-now": {
    heading: "Login approved",
    body: (
      <>
        Your terminal will finish signing in on its own. You can close this tab.
      </>
    ),
  },
  approved: {
    heading: "Login already approved",
    body: (
      <>
        This request was already approved. Run <code>jv login</code> again if
        your terminal didn&apos;t finish.
      </>
    ),
  },
  denied: {
    heading: "Login denied",
    body: (
      <>
        This login request was denied. Run <code>jv login</code> again if that
        was a mistake.
      </>
    ),
  },
  expired: {
    heading: "Login request expired",
    body: (
      <>
        Run <code>jv login</code> again to start a new request.
      </>
    ),
  },
  "not-found": {
    heading: "Login request not found",
    body: (
      <>
        Check the link, or run <code>jv login</code> again.
      </>
    ),
  },
} as const;

const LoginRequestForm = ({
  request,
  userId,
  onOutcome,
  onConflict,
}: {
  request: LoginRequest;
  userId: string;
  onOutcome: (outcome: Outcome) => void;
  onConflict: () => Promise<void>;
}) => {
  const picker = useApiKeyPicker(userId, true);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [selectedPermissions, setSelectedPermissions] = useState<Permission[]>([
    "read",
    "inject",
  ]);
  const [scopeErrors, setScopeErrors] = useState<string[]>([]);
  const [permissionErrors, setPermissionErrors] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [action, setAction] = useState<"approve" | "deny" | null>(null);
  const initialized = useRef(false);
  const pending = useRef(false);

  useEffect(() => {
    if (initialized.current || picker.pickerLoading || picker.pickerFailed) {
      return;
    }
    initialized.current = true;
    const owned = Object.fromEntries(
      picker.projectList.map((project, index) => [
        project.slug,
        picker.environments[index]?.data?.map((env) => env.slug) ?? [],
      ])
    );
    setSelected(suggestedSelection(request, owned));
  }, [picker, request]);

  const submit = async (nextAction: "approve" | "deny") => {
    if (pending.current) {
      return;
    }
    if (nextAction === "approve") {
      const missingScope = !Object.values(selected).some(
        (envs) => envs.length > 0
      );
      const missingPermissions = selectedPermissions.length === 0;
      setScopeErrors(missingScope ? ["Choose at least one environment."] : []);
      setPermissionErrors(
        missingPermissions ? ["Choose at least one permission."] : []
      );
      if (missingScope || missingPermissions || !picker.pickerReady) {
        return;
      }
    }
    pending.current = true;
    setAction(nextAction);
    setSubmitError(null);
    try {
      if (nextAction === "approve") {
        await client.loginRequests.approve({
          id: request.id,
          scope: buildScope(selected),
          permissions: selectedPermissions,
        });
        onOutcome("approved-now");
      } else {
        await client.loginRequests.deny({ id: request.id });
        onOutcome("denied");
      }
    } catch (error) {
      if (error instanceof ORPCError && error.code === "CONFLICT") {
        await onConflict();
      } else if (isProjectNotFound(error)) {
        onOutcome("not-found");
      } else {
        setSubmitError(
          nextAction === "approve"
            ? "Couldn't approve the request. Try again."
            : "Couldn't deny the request. Try again."
        );
        if (
          nextAction === "approve" &&
          error instanceof ORPCError &&
          error.code === "BAD_REQUEST"
        ) {
          await picker.refreshPicker();
        }
      }
    }
    pending.current = false;
    setAction(null);
  };

  return (
    <>
      <h1 className="text-2xl font-semibold">Approve CLI login</h1>
      <p className="wrap-anywhere">
        {request.machineName} wants to sign in from the command line. Requested{" "}
        <time dateTime={request.requestedAt}>
          {dateFormatter.format(new Date(request.requestedAt))}
        </time>
        .
      </p>
      <p>
        Approving gives this machine an API key with the access you choose
        below.
      </p>
      <form
        className="flex min-w-0 flex-col gap-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit("approve");
        }}
      >
        <ApiKeyScopeField
          value={selected}
          onChange={setSelected}
          errors={scopeErrors}
          disabled={action !== null}
          idPrefix="cli-login"
          picker={picker}
        />
        <ApiKeyPermissionsField
          value={selectedPermissions}
          onChange={setSelectedPermissions}
          errors={permissionErrors}
          disabled={action !== null}
          idPrefix="cli-login"
        />
        {submitError && (
          <p role="alert" className="text-destructive">
            {submitError}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={action !== null || !picker.pickerReady}
          >
            {action === "approve" ? "Approving..." : "Approve"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={action !== null}
            onClick={() => submit("deny")}
          >
            {action === "deny" ? "Denying..." : "Deny"}
          </Button>
        </div>
      </form>
    </>
  );
};

const LoginRequestPage = ({ id, userId }: { id: string; userId: string }) => {
  const request = useQuery(
    orpc.loginRequests.read.queryOptions({
      input: { id },
      queryKey: [...orpc.loginRequests.read.key({ input: { id } }), { userId }],
      retry: retryProjectQuery,
      staleTime: 0,
    })
  );
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const focusAfterAction = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const state =
    outcome ??
    (isProjectNotFound(request.error) ? "not-found" : request.data?.status);

  useEffect(() => {
    if (state && state !== "pending" && focusAfterAction.current) {
      heading.current?.focus();
      focusAfterAction.current = false;
    }
  }, [state]);

  if (state && state !== "pending") {
    const result = outcomes[state];
    return (
      <>
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold">
          {result.heading}
        </h1>
        <p>{result.body}</p>
      </>
    );
  }
  if (request.isPending) {
    return (
      <output aria-label="Loading login request">
        <Skeleton className="h-48 w-full" />
      </output>
    );
  }
  if (request.isError) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p role="alert">Couldn&apos;t load the login request.</p>
        <Button variant="outline" onClick={() => request.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <LoginRequestForm
      request={request.data}
      userId={userId}
      onOutcome={(nextOutcome) => {
        focusAfterAction.current = true;
        setOutcome(nextOutcome);
      }}
      onConflict={async () => {
        focusAfterAction.current = true;
        await request.refetch();
      }}
    />
  );
};

const AuthorizePage = () => {
  const { session } = Route.useRouteContext();
  const { request } = Route.useSearch();
  return (
    <main className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-6 p-6">
      {request ? (
        <LoginRequestPage
          key={`${session.user.id}/${request}`}
          id={request}
          userId={session.user.id}
        />
      ) : (
        <>
          <h1 className="text-2xl font-semibold">No login request</h1>
          <p>
            Open this page from the link <code>jv login</code> prints.
          </p>
        </>
      )}
    </main>
  );
};

export const Route = createFileRoute("/_auth/cli/authorize")({
  component: AuthorizePage,
  validateSearch: (search: Record<string, unknown>): { request?: string } => ({
    request:
      typeof search.request === "string" && search.request.length > 0
        ? search.request
        : undefined,
  }),
});
