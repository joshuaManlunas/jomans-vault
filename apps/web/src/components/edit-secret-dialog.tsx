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
import { Label } from "@jomans-vault/ui/components/label";
import { Textarea } from "@jomans-vault/ui/components/textarea";
import { ORPCError } from "@orpc/client";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { RefObject } from "react";
import { z } from "zod";

import { useProjectPage } from "@/lib/project-page";
import { secretValueField } from "@/lib/secret-fields";
import { client, orpc } from "@/utils/orpc";

const messages = {
  conflict:
    "This secret changed since you opened this dialog. Reload to get the latest version, then save to replace it.",
  missing: "This secret no longer exists.",
  "bad-request": "The server refused this value. Check it and try again.",
  other: "Couldn't save the secret. Try again.",
};

interface EditSecretDialogProps {
  project: string;
  env: string;
  target: { key: string; version: number } | null;
  opener: HTMLElement | null;
  onClose: () => void;
  addButton: RefObject<HTMLButtonElement | null>;
}

const EditSecretDialogSession = ({
  project,
  env,
  target,
  opener,
  onClose,
  addButton,
  open,
}: EditSecretDialogProps & { open: boolean }) => {
  const queryClient = useQueryClient();
  const { secrets } = useProjectPage();
  const [version, setVersion] = useState(target?.version ?? 0);
  const [error, setError] = useState<keyof typeof messages | null>(null);
  const [reloading, setReloading] = useState(false);
  const valueInput = useRef<HTMLTextAreaElement>(null);
  const returnFocus = useRef(opener);
  const removed = useRef(false);
  const pending = useRef(false);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: orpc.secrets.list.key({ input: { project, env } }),
    });

  const form = useForm({
    defaultValues: { value: "" },
    validators: {
      onSubmit: z.object({
        value: secretValueField.refine((value) => value.length > 0, {
          message: "Enter a new value.",
        }),
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      if (!target || pending.current || removed.current) {
        return;
      }
      pending.current = true;
      setError(null);
      try {
        await client.secrets.patch({
          project,
          env,
          key: target.key,
          value: value.value,
          expectedVersion: version,
        });
        await refresh();
        formApi.reset();
        onClose();
      } catch (error_) {
        if (error_ instanceof ORPCError && error_.code === "NOT_FOUND") {
          removed.current = true;
          setError("missing");
          await refresh();
        } else if (error_ instanceof ORPCError && error_.code === "CONFLICT") {
          setError("conflict");
        } else {
          setError(
            error_ instanceof ORPCError && error_.code === "BAD_REQUEST"
              ? "bad-request"
              : "other"
          );
        }
      }
      pending.current = false;
    },
  });

  const reload = async () => {
    if (!target || pending.current || removed.current) {
      return;
    }
    pending.current = true;
    setReloading(true);
    const result = await secrets.refetch();
    if (result.isError) {
      setError("other");
    } else {
      const secret = result.data?.find((row) => row.key === target.key);
      if (secret) {
        setVersion(secret.version);
        setError(null);
      } else {
        removed.current = true;
        setError("missing");
        await refresh();
      }
    }
    pending.current = false;
    setReloading(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && (pending.current || form.state.isSubmitting)) {
          details.cancel();
          return;
        }
        if (!nextOpen) {
          form.reset();
          onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100svh-2rem)] overflow-y-auto"
        initialFocus={valueInput}
        finalFocus={() =>
          removed.current || !returnFocus.current?.isConnected
            ? addButton.current
            : returnFocus.current
        }
      >
        <DialogHeader>
          <DialogTitle>Edit secret</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{target?.key}</span>. Saving replaces
            version {version}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (
              !pending.current &&
              !form.state.isSubmitting &&
              !removed.current
            ) {
              form.handleSubmit();
            }
          }}
        >
          <form.Field name="value">
            {(field) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="edit-secret-value">New value</Label>
                <Textarea
                  ref={valueInput}
                  id="edit-secret-value"
                  rows={5}
                  className="max-h-64 min-h-32 overflow-y-auto"
                  autoComplete="off"
                  spellCheck={false}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={field.state.meta.errors.length > 0}
                  aria-describedby="edit-secret-value-errors"
                />
                <div id="edit-secret-value-errors" className="text-destructive">
                  {field.state.meta.errors.map((issue) => (
                    <p key={issue?.message}>{issue?.message}</p>
                  ))}
                </div>
              </div>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => {
              const busy = isSubmitting || reloading;
              return (
                <>
                  {error && (
                    <div className="flex items-start gap-2">
                      <p role="alert" className="text-destructive">
                        {messages[error]}
                      </p>
                      {error === "conflict" && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          aria-busy={reloading}
                          onClick={reload}
                        >
                          {reloading ? "Reloading..." : "Reload"}
                        </Button>
                      )}
                    </div>
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
                          type="button"
                          variant="outline"
                          disabled={busy}
                        />
                      }
                    >
                      Cancel
                    </DialogClose>
                    <Button
                      type="submit"
                      disabled={busy || error === "missing"}
                      aria-busy={isSubmitting}
                    >
                      {isSubmitting ? "Saving..." : "Save"}
                    </Button>
                  </DialogFooter>
                </>
              );
            }}
          </form.Subscribe>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const EditSecretDialog = (props: EditSecretDialogProps) => {
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
    <EditSecretDialogSession
      key={session.id}
      {...props}
      target={session.target}
      opener={session.opener}
      open={props.target !== null}
    />
  );
};
