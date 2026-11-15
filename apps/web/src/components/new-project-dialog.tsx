import { slug } from "@jomans-vault/api/routers/validation";
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
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { orpc } from "@/utils/orpc";

const projectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name.")
    .max(100, "Use 100 characters or fewer."),
  slug: z.string().superRefine((value, context) => {
    const result = slug.safeParse(value);
    if (result.success) {
      return;
    }
    const [issue] = result.error.issues;
    let message = "Use only lowercase letters, digits and hyphens.";
    if (issue?.code === "too_small") {
      message = "Enter a slug.";
    } else if (issue?.code === "too_big") {
      message = "Use 64 characters or fewer.";
    }
    context.addIssue({ code: "custom", message });
  }),
});

const suggestSlug = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replaceAll(/-+$/gu, "");

export const NewProjectDialog = ({ children }: { children: ReactNode }) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [submitError, setSubmitError] = useState<"conflict" | "other" | null>(
    null
  );
  const nameInput = useRef<HTMLInputElement>(null);
  const headerButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const created = useRef(false);

  const mutation = useMutation(orpc.projects.create.mutationOptions());

  const form = useForm({
    defaultValues: { name: "", slug: "" },
    validators: { onSubmit: projectSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync({
          name: value.name.trim(),
          slug: value.slug,
        });
        await queryClient.invalidateQueries({
          queryKey: orpc.projects.list.key(),
        });
        created.current = true;
        setOpen(false);
        formApi.reset();
        setSlugEdited(false);
        setSubmitError(null);
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
    setSlugEdited(false);
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
        <h1 className="text-2xl font-semibold">Projects</h1>
        <DialogTrigger render={<Button ref={headerButton} />}>
          New project
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
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Give your project a name and a unique slug.
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
          <form.Field name="name">
            {(field) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="project-name">Name</Label>
                <Input
                  ref={nameInput}
                  id="project-name"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    if (!slugEdited) {
                      form.setFieldValue(
                        "slug",
                        suggestSlug(event.target.value)
                      );
                    }
                  }}
                  aria-invalid={field.state.meta.errors.length > 0}
                  aria-describedby="project-name-errors"
                />
                <div id="project-name-errors" className="text-destructive">
                  {field.state.meta.errors.map((error) => (
                    <p key={error?.message}>{error?.message}</p>
                  ))}
                </div>
              </div>
            )}
          </form.Field>
          <form.Field name="slug">
            {(field) => (
              <div className="flex flex-col gap-2">
                <Label htmlFor="project-slug">Slug</Label>
                <Input
                  id="project-slug"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    setSlugEdited(true);
                    field.handleChange(event.target.value);
                  }}
                  aria-invalid={
                    field.state.meta.errors.length > 0 ||
                    submitError === "conflict"
                  }
                  aria-describedby="project-slug-errors"
                />
                <div id="project-slug-errors" className="text-destructive">
                  {field.state.meta.errors.map((error) => (
                    <p key={error?.message}>{error?.message}</p>
                  ))}
                  {submitError === "conflict" && (
                    <p>You already have a project with this slug.</p>
                  )}
                </div>
              </div>
            )}
          </form.Field>
          {submitError === "other" && (
            <p role="alert" className="text-destructive">
              Couldn&apos;t create the project. Try again.
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
                  {isSubmitting ? "Creating..." : "Create project"}
                </Button>
              </DialogFooter>
            )}
          </form.Subscribe>
        </form>
      </DialogContent>
    </Dialog>
  );
};
