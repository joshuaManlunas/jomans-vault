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

interface RevokeApiKeyDialogProps {
  target: { id: string; name: string | null };
  opener: HTMLElement;
  open: boolean;
  onClose: () => void;
  headerButton: RefObject<HTMLButtonElement | null>;
}

export const RevokeApiKeyDialog = ({
  target,
  opener,
  open,
  onClose,
  headerButton,
}: RevokeApiKeyDialogProps) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"missing" | "other" | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const revoked = useRef(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });

  const revoke = async () => {
    if (pending.current || revoked.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await client.apiKeys.revoke({ id: target.id });
      revoked.current = true;
      await refresh();
      onClose();
    } catch (error_) {
      if (error_ instanceof ORPCError && error_.code === "NOT_FOUND") {
        revoked.current = true;
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
          revoked.current || !opener.isConnected ? headerButton.current : opener
        }
      >
        <DialogHeader>
          <DialogTitle>Revoke API key</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            Revoke {target.name ?? "Unnamed key"}? Anything using it will stop
            working immediately. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive">
            {error === "missing"
              ? "This key no longer exists."
              : "Couldn't revoke the key. Try again."}
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
            onClick={revoke}
          >
            {busy ? "Revoking..." : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
