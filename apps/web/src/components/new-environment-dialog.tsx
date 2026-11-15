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
import { ORPCError } from "@orpc/client";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { slugField } from "@/lib/slug-field";
import { orpc } from "@/utils/orpc";

const environmentSchema = z.object({ slug: slugField("Enter a name.") });

export const NewEnvironmentDialog = ({
  project,
  projectName,
  children,
}: {
  project: string;
  projectName: string;
  children: ReactNode;
}) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [submitError, setSubmitError] = useState<"conflict" | "other" | null>(
    null
  );
  const nameInput = useRef<HTMLInputElement>(null);
  const headerButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const created = useRef(false);

  const mutation = useMutation(orpc.environments.create.mutationOptions());

  const form = useForm({
    defaultValues: { slug: "" },
    validators: { onSubmit: environmentSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync({
          project,
          slug: value.slug,
        });
        await queryClient.invalidateQueries({
          queryKey: orpc.environments.list.key({ input: { project } }),
        });
        created.current = true;
        setOpen(false);
        formApi.reset();
        setSubmitError(null);
        await navigate({
          to: "/projects/$project/$env",
          params: { project, env: value.slug },
        });
      } catch (error) {
        setSubmitError(
          error instanceof ORPCError && error.code === "CONFLICT"
            ? "conflict"
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
        <h1 className="min-w-0 text-2xl font-semibold wrap-anywhere">
          {projectName}
        </h1>
        <DialogTrigger render={<Button ref={headerButton} />}>
          Add environment
        </DialogTrigger>
      </div>
      {children}
      <DialogContent
        initialFocus={nameInput}
        finalFocus={() =>
          created.current || !opener.current?.isConnected
            ? headerButton.current
            : opener.current
        }
      >
        <DialogHeader>
          <DialogTitle>Add environment</DialogTitle>
          <DialogDescription>
            Use lowercase letters, digits and hyphens, for example development.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!form.state.isSubmitting) {
              setSubmitError(null);
              form.handleSubmit();
            }
          }}
        >
          <form.Field name="slug">
            {(field) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="environment-name">Name</Label>
                <Input
                  ref={nameInput}
                  id="environment-name"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                  }}
                  aria-invalid={
                    field.state.meta.errors.length > 0 ||
                    submitError === "conflict"
                  }
                  aria-describedby="environment-name-errors"
                />
                <div id="environment-name-errors" className="text-destructive">
                  {field.state.meta.errors.map((error) => (
                    <p key={error?.message}>{error?.message}</p>
                  ))}
                  {submitError === "conflict" && (
                    <p>
                      This project already has an environment with this name.
                    </p>
                  )}
                </div>
              </div>
            )}
          </form.Field>
          {submitError === "other" && (
            <p role="alert" className="text-destructive">
              Couldn&apos;t create the environment. Try again.
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
                  {isSubmitting ? "Adding..." : "Add environment"}
                </Button>
              </DialogFooter>
            )}
          </form.Subscribe>
        </form>
      </DialogContent>
    </Dialog>
  );
};
