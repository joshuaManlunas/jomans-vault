import { Button } from "@jomans-vault/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@jomans-vault/ui/components/dialog";
import { ORPCError } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { RefObject } from "react";

import { client, orpc } from "@/utils/orpc";

interface RollbackSecretDialogProps {
  project: string;
  env: string;
  secretKey: string;
  version: number | null;
  nextVersion: number;
  opener: HTMLElement | null;
  successFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSuccess: (
    result: Awaited<ReturnType<typeof client.secrets.rollback>>
  ) => Promise<void>;
}

const RollbackSecretDialogSession = ({
  project,
  env,
  secretKey,
  version,
  nextVersion,
  opener,
  successFocus,
  onClose,
  onSuccess,
  open,
}: RollbackSecretDialogProps & { open: boolean }) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"missing" | "other" | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const rolledBack = useRef(false);

  const rollback = async () => {
    if (version === null || pending.current || rolledBack.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof client.secrets.rollback>>;
    try {
      result = await client.secrets.rollback({
        project,
        env,
        key: secretKey,
        version,
      });
    } catch (error_) {
      setError(
        error_ instanceof ORPCError && error_.code === "NOT_FOUND"
          ? "missing"
          : "other"
      );
      pending.current = false;
      setBusy(false);
      return;
    }
    rolledBack.current = true;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: orpc.secrets.list.key({ input: { project, env } }),
      }),
      onSuccess(result),
    ]);
    pending.current = false;
    setBusy(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && pending.current) {
          details.cancel();
          return;
        }
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={cancelButton}
        finalFocus={() => (rolledBack.current ? successFocus.current : opener)}
      >
        <DialogHeader>
          <DialogTitle>Roll back to version {version}</DialogTitle>
          <DialogDescription>
            Make version {version} current? This adds version {nextVersion} with
            version {version}&apos;s value. Newer versions stay in the history.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive">
            {error === "missing"
              ? "This version or secret no longer exists."
              : "Couldn't roll back. Try again."}
          </p>
        )}
        <DialogClose
          render={
            <Button
              type="button"
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
              disabled={busy}
            />
          }
        >
          <XIcon aria-hidden="true" />
          <span className="sr-only">Close</span>
        </DialogClose>
        <DialogFooter>
          <DialogClose
            render={
              <Button
                ref={cancelButton}
                type="button"
                variant="outline"
                disabled={busy}
              />
            }
          >
            Cancel
          </DialogClose>
          <Button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={rollback}
          >
            {busy ? "Rolling back..." : "Roll back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const RollbackSecretDialog = (props: RollbackSecretDialogProps) => {
  const [session, setSession] = useState({
    selection: props.version,
    version: props.version,
    nextVersion: props.nextVersion,
    opener: props.opener,
    id: 0,
  });
  if (props.version !== session.selection) {
    setSession({
      selection: props.version,
      version: props.version ?? session.version,
      nextVersion:
        props.version === null ? session.nextVersion : props.nextVersion,
      opener: props.opener ?? session.opener,
      id: props.version === null ? session.id : session.id + 1,
    });
  }
  return (
    <RollbackSecretDialogSession
      key={session.id}
      {...props}
      version={session.version}
      nextVersion={session.nextVersion}
      opener={session.opener}
      open={props.version !== null}
    />
  );
};
