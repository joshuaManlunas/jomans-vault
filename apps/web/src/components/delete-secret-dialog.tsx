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

interface DeleteSecretDialogProps {
  project: string;
  env: string;
  target: { key: string } | null;
  opener: HTMLElement | null;
  onClose: () => void;
  addButton: RefObject<HTMLButtonElement | null>;
}

const DeleteSecretDialogSession = ({
  project,
  env,
  target,
  opener,
  onClose,
  addButton,
  open,
}: DeleteSecretDialogProps & { open: boolean }) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"missing" | "other" | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(opener);
  const removed = useRef(false);
  const pending = useRef(false);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: orpc.secrets.list.key({ input: { project, env } }),
    });

  const remove = async () => {
    if (!target || pending.current || removed.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await client.secrets.delete({ project, env, key: target.key });
      removed.current = true;
      await refresh();
      onClose();
    } catch (error_) {
      if (error_ instanceof ORPCError && error_.code === "NOT_FOUND") {
        removed.current = true;
        setError("missing");
        await refresh();
      } else {
        setError("other");
      }
    }
    pending.current = false;
    setBusy(false);
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
        finalFocus={() =>
          removed.current || !returnFocus.current?.isConnected
            ? addButton.current
            : returnFocus.current
        }
      >
        <DialogHeader>
          <DialogTitle>Delete secret</DialogTitle>
          <DialogDescription>
            Delete <span className="font-mono">{target?.key}</span> from this
            environment? Its version history is kept.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive">
            {error === "missing"
              ? "This secret no longer exists."
              : "Couldn't delete the secret. Try again."}
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
            variant="destructive"
            disabled={busy || error === "missing"}
            aria-busy={busy}
            onClick={remove}
          >
            {busy ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const DeleteSecretDialog = (props: DeleteSecretDialogProps) => {
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
    <DeleteSecretDialogSession
      key={session.id}
      {...props}
      target={session.target}
      opener={session.opener}
      open={props.target !== null}
    />
  );
};
