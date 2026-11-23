import { Badge } from "@jomans-vault/ui/components/badge";
import { Button } from "@jomans-vault/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@jomans-vault/ui/components/sheet";
import { Skeleton } from "@jomans-vault/ui/components/skeleton";
import { ORPCError } from "@orpc/client";
import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";

import { RollbackSecretDialog } from "@/components/rollback-secret-dialog";
import { dateFormatter } from "@/lib/date-format";
import { client } from "@/utils/orpc";

interface SecretHistoryDrawerProps {
  project: string;
  env: string;
  target: { key: string } | null;
  opener: HTMLElement | null;
  onClose: () => void;
  addButton: RefObject<HTMLButtonElement | null>;
  currentUser: { id: string; name: string };
}

type HistoryState =
  | { status: "loading" }
  | {
      status: "success";
      versions: Awaited<ReturnType<typeof client.secrets.versions>>;
    }
  | { status: "missing" | "error" };

const SecretHistoryBody = ({
  project,
  env,
  target,
  open,
  currentUser,
  onRetry,
}: Pick<
  SecretHistoryDrawerProps,
  "project" | "env" | "target" | "currentUser"
> & {
  open: boolean;
  onRetry: () => void;
}) => {
  const [history, setHistory] = useState<HistoryState>({ status: "loading" });
  const [rollbackTarget, setRollbackTarget] = useState<{
    version: number;
    opener: HTMLElement;
  } | null>(null);
  const successFocus = useRef<HTMLElement>(null);
  const versionId = useId();
  const secretKey = target?.key;

  const reloadAfterRollback = async (
    _result: Awaited<ReturnType<typeof client.secrets.rollback>>
  ) => {
    if (!secretKey) {
      return;
    }
    try {
      const versions = await client.secrets.versions({
        project,
        env,
        key: secretKey,
      });
      const newestFirst: typeof versions = [];
      for (const version of versions) {
        newestFirst.unshift(version);
      }
      setHistory({ status: "success", versions: newestFirst });
    } catch {
      setHistory({ status: "error" });
    }
  };

  useEffect(() => {
    if (!open || !secretKey) {
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      // Let an effect cleanup cancel the request before it is sent.
      await Promise.resolve();
      if (controller.signal.aborted) {
        return;
      }
      try {
        const versions = await client.secrets.versions(
          { project, env, key: secretKey },
          { signal: controller.signal }
        );
        if (!controller.signal.aborted) {
          const newestFirst: typeof versions = [];
          for (const version of versions) {
            newestFirst.unshift(version);
          }
          setHistory({ status: "success", versions: newestFirst });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setHistory({
            status:
              error instanceof ORPCError && error.code === "NOT_FOUND"
                ? "missing"
                : "error",
          });
        }
      }
    };
    load();
    return () => controller.abort();
  }, [project, env, secretKey, open]);

  return (
    <>
      {history.status === "loading" && (
        <output
          aria-label="Loading history"
          className="flex flex-col gap-4 px-4 pb-4"
        >
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </output>
      )}
      {(history.status === "missing" || history.status === "error") && (
        <div className="flex flex-col items-start gap-4 px-4 pb-4">
          <p role="alert">
            {history.status === "missing"
              ? "This secret no longer exists."
              : "Couldn't load this secret's history."}
          </p>
          {history.status === "error" && (
            <Button
              ref={(element) => {
                successFocus.current = element;
              }}
              variant="outline"
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {history.status === "success" && (
        <ol className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-4">
          {history.versions.map((version, index) => (
            <li key={version.version} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  id={`${versionId}-${version.version}`}
                  ref={index === 0 ? successFocus : undefined}
                  tabIndex={-1}
                  className="font-medium"
                >
                  Version {version.version}
                </span>
                {index === 0 && <Badge variant="secondary">Current</Badge>}
              </div>
              {version.createdByType === "user" &&
              version.createdById === currentUser.id ? (
                <span className="wrap-anywhere">{currentUser.name}</span>
              ) : (
                <span className="font-mono wrap-anywhere">
                  {version.createdByType} {version.createdById}
                </span>
              )}
              <time
                dateTime={version.createdAt}
                className="text-muted-foreground"
              >
                {dateFormatter.format(new Date(version.createdAt))}
              </time>
              {index > 0 && (
                <Button
                  variant="outline"
                  className="self-start"
                  aria-describedby={`${versionId}-${version.version}`}
                  onClick={(event) =>
                    setRollbackTarget({
                      version: version.version,
                      opener: event.currentTarget,
                    })
                  }
                >
                  Roll back to this version
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      {secretKey && (
        <RollbackSecretDialog
          project={project}
          env={env}
          secretKey={secretKey}
          version={rollbackTarget?.version ?? null}
          nextVersion={
            history.status === "success"
              ? (history.versions[0]?.version ?? 0) + 1
              : 0
          }
          opener={rollbackTarget?.opener ?? null}
          successFocus={successFocus}
          onClose={() => setRollbackTarget(null)}
          onSuccess={reloadAfterRollback}
        />
      )}
    </>
  );
};

const SecretHistoryDrawerSession = ({
  project,
  env,
  target,
  opener,
  onClose,
  addButton,
  currentUser,
  open,
}: SecretHistoryDrawerProps & { open: boolean }) => {
  const [attempt, setAttempt] = useState(0);

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <SheetContent
        side="right"
        className="overflow-hidden"
        finalFocus={() => (opener?.isConnected ? opener : addButton.current)}
      >
        <SheetHeader className="shrink-0 pr-12">
          <SheetTitle className="wrap-anywhere">
            History for <span className="font-mono">{target?.key}</span>
          </SheetTitle>
          <SheetDescription>
            Versions of this secret, newest first. Values are not shown.
          </SheetDescription>
        </SheetHeader>
        <SecretHistoryBody
          key={attempt}
          project={project}
          env={env}
          target={target}
          currentUser={currentUser}
          open={open}
          onRetry={() => setAttempt((previous) => previous + 1)}
        />
      </SheetContent>
    </Sheet>
  );
};

export const SecretHistoryDrawer = (props: SecretHistoryDrawerProps) => {
  const [session, setSession] = useState({
    target: props.target,
    opener: props.opener,
    id: 0,
  });
  if (props.target && props.target !== session.target) {
    setSession({
      target: props.target,
      opener: props.opener,
      id: session.id + 1,
    });
  }
  return (
    <SecretHistoryDrawerSession
      key={session.id}
      {...props}
      target={session.target}
      opener={session.opener}
      open={props.target !== null}
    />
  );
};
