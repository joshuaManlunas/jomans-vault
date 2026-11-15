import { Button } from "@jomans-vault/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@jomans-vault/ui/components/dialog";
import { Input } from "@jomans-vault/ui/components/input";
import { Label } from "@jomans-vault/ui/components/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@jomans-vault/ui/components/select";
import { Textarea } from "@jomans-vault/ui/components/textarea";
import { ORPCError } from "@orpc/client";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  SECRET_KINDS,
  secretKeyField,
  secretValueField,
} from "@/lib/secret-fields";
import { client, orpc } from "@/utils/orpc";

export const NewSecretDialog = ({
  project,
  env,
  existingKeys,
  children,
}: {
  project: string;
  env: string;
  existingKeys: readonly string[];
  children: ReactNode;
}) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [submitError, setSubmitError] = useState<
    "bad-request" | "other" | null
  >(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const headerButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const created = useRef(false);

  const form = useForm({
    defaultValues: {
      key: "",
      value: "",
      kind: "secret" as (typeof SECRET_KINDS)[number],
    },
    validators: {
      onSubmit: z.object({
        key: secretKeyField.refine((key) => !existingKeys.includes(key), {
          message:
            "This environment already has a secret with this key. Edit it instead.",
        }),
        value: secretValueField,
        kind: z.enum(SECRET_KINDS),
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      try {
        await client.secrets.set({
          project,
          env,
          ...value,
        });
        await queryClient.invalidateQueries({
          queryKey: orpc.secrets.list.key({ input: { project, env } }),
        });
        created.current = true;
        setOpen(false);
        formApi.reset();
        setSubmitError(null);
      } catch (error) {
        setSubmitError(
          error instanceof ORPCError && error.code === "BAD_REQUEST"
            ? "bad-request"
            : "other"
        );
      }
    },
  });

  const resetForm = () => {
    form.reset();
    setSubmitError(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && form.state.isSubmitting) {
          details.cancel();
          return;
        }
        if (nextOpen) {
          opener.current =
            details.trigger instanceof HTMLElement ? details.trigger : null;
          created.current = false;
        } else {
          resetForm();
        }
        setOpen(nextOpen);
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">Secrets</h2>
        <DialogTrigger render={<Button ref={headerButton} />}>
          Add secret
        </DialogTrigger>
      </div>
      {children}
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto"
        initialFocus={keyInput}
        finalFocus={() =>
          created.current || !opener.current?.isConnected
            ? headerButton.current
            : opener.current
        }
      >
        <DialogHeader>
          <DialogTitle>Add secret</DialogTitle>
          <DialogDescription>
            Add a key and value to this environment.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!form.state.isSubmitting) {
              setSubmitError(null);
              form.handleSubmit();
            }
          }}
        >
          <form.Field name="key">
            {(field) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="secret-key">Key</Label>
                <Input
                  ref={keyInput}
                  id="secret-key"
                  className="font-mono"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={field.state.meta.errors.length > 0}
                  aria-describedby="secret-key-errors"
                />
                <div id="secret-key-errors" className="text-destructive">
                  {field.state.meta.errors.map((error) => (
                    <p key={error?.message}>{error?.message}</p>
                  ))}
                </div>
              </div>
            )}
          </form.Field>
          <form.Field name="value">
            {(field) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="secret-value">Value</Label>
                <Textarea
                  id="secret-value"
                  rows={5}
                  className="max-h-64 min-h-32 overflow-y-auto"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={field.state.meta.errors.length > 0}
                  aria-describedby="secret-value-errors"
                />
                <div id="secret-value-errors" className="text-destructive">
                  {field.state.meta.errors.map((error) => (
                    <p key={error?.message}>{error?.message}</p>
                  ))}
                </div>
              </div>
            )}
          </form.Field>
          <form.Field name="kind">
            {(field) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="secret-kind">Kind</Label>
                <Select
                  name={field.name}
                  value={field.state.value}
                  onValueChange={(value) => {
                    if (value) {
                      field.handleChange(value);
                    }
                  }}
                >
                  <SelectTrigger
                    id="secret-kind"
                    onBlur={field.handleBlur}
                    aria-invalid={field.state.meta.errors.length > 0}
                    aria-describedby="secret-kind-errors"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {SECRET_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {kind}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div id="secret-kind-errors" className="text-destructive">
                  {field.state.meta.errors.map((error) => (
                    <p key={error?.message}>{error?.message}</p>
                  ))}
                </div>
              </div>
            )}
          </form.Field>
          {submitError && (
            <p role="alert" className="text-destructive">
              {submitError === "bad-request"
                ? "The server refused this key or value. Check them and try again."
                : "Couldn't add the secret. Try again."}
            </p>
          )}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <DialogFooter>
                <DialogClose
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isSubmitting}
                    />
                  }
                >
                  Cancel
                </DialogClose>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Adding..." : "Add secret"}
                </Button>
              </DialogFooter>
            )}
          </form.Subscribe>
        </form>
      </DialogContent>
    </Dialog>
  );
};
