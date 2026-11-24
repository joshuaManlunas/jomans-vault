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
import { ORPCError } from "@orpc/client";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { z } from "zod";

import {
  ApiKeyPermissionsField,
  ApiKeyScopeField,
  useApiKeyPicker,
} from "@/components/api-key-access-fields";
import { buildScope, expiryPresets, permissions } from "@/lib/api-key-form";
import { client, orpc } from "@/utils/orpc";

type Permission = (typeof permissions)[number];
type Expiry = (typeof expiryPresets)[number]["value"];

const apiKeySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name.")
    .max(32, "Use 32 characters or fewer."),
  expiry: z.enum(["never", "7d", "30d", "90d", "1y"]),
  selected: z
    .record(z.string(), z.array(z.string()))
    .refine(
      (selected) => Object.values(selected).some((envs) => envs.length > 0),
      "Choose at least one environment."
    ),
  permissions: z
    .array(z.enum(permissions))
    .min(1, "Choose at least one permission."),
});

const OneTimeKey = ({ value }: { value: string }) => {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const copy = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Copy your new API key</DialogTitle>
        <DialogDescription>
          This is the only time this key will be shown. Store it somewhere safe
          now.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="new-api-key-value">API key</Label>
        <Input
          ref={input}
          id="new-api-key-value"
          className="font-mono"
          value={value}
          readOnly
        />
      </div>
      {copyFailed && (
        <p role="alert" className="text-destructive">
          Couldn&apos;t copy. Select the key and copy it manually.
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={copy}>
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </Button>
        <DialogClose render={<Button type="button" />}>Done</DialogClose>
      </DialogFooter>
    </>
  );
};

export const NewApiKeyDialog = ({
  userId,
  headerButton,
  children,
}: {
  userId: string;
  headerButton: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const created = useRef(false);
  const pending = useRef(false);
  const picker = useApiKeyPicker(userId, open);
  const { pickerReady, refreshPicker } = picker;

  const form = useForm({
    defaultValues: {
      name: "",
      expiry: "never" as Expiry,
      selected: {} as Record<string, string[]>,
      permissions: ["read"] as Permission[],
    },
    validators: { onSubmit: apiKeySchema },
    onSubmit: async ({ value }) => {
      if (pending.current || !pickerReady) {
        return;
      }
      pending.current = true;
      setSubmitError(false);
      try {
        const expiresIn = expiryPresets.find(
          (preset) => preset.value === value.expiry
        )?.seconds;
        const result = await client.apiKeys.create({
          name: value.name.trim(),
          ...(expiresIn === undefined ? {} : { expiresIn }),
          scope: buildScope(value.selected),
          permissions: value.permissions,
        });
        created.current = true;
        setNewKey(result.key);
        await queryClient.invalidateQueries({
          queryKey: orpc.apiKeys.list.key(),
        });
      } catch (error) {
        setSubmitError(true);
        if (error instanceof ORPCError && error.code === "BAD_REQUEST") {
          await refreshPicker();
        }
      }
      pending.current = false;
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (
          !nextOpen &&
          (pending.current ||
            (newKey !== null && details.reason === "outside-press"))
        ) {
          details.cancel();
          return;
        }
        if (nextOpen) {
          opener.current =
            details.trigger instanceof HTMLElement ? details.trigger : null;
          created.current = false;
        } else {
          setNewKey(null);
          setSubmitError(false);
          form.reset();
        }
        setOpen(nextOpen);
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">API keys</h1>
        <DialogTrigger render={<Button ref={headerButton} />}>
          New API key
        </DialogTrigger>
      </div>
      {children}
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={false}
        initialFocus={nameInput}
        finalFocus={() =>
          created.current || !opener.current?.isConnected
            ? headerButton.current
            : opener.current
        }
      >
        {newKey === null ? (
          <>
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>
                Choose the environments and permissions this key can access.
              </DialogDescription>
            </DialogHeader>
            <form
              className="flex min-w-0 flex-col gap-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!pending.current && pickerReady) {
                  form.handleSubmit();
                }
              }}
            >
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(busy) => (
                  <fieldset
                    disabled={busy}
                    className="flex min-w-0 flex-col gap-4"
                  >
                    <legend className="sr-only">API key details</legend>
                    <form.Field name="name">
                      {(field) => (
                        <div className="flex flex-col gap-2">
                          <Label htmlFor="api-key-name">Name</Label>
                          <Input
                            ref={nameInput}
                            id="api-key-name"
                            name={field.name}
                            required
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                              field.handleChange(event.target.value)
                            }
                            aria-invalid={field.state.meta.errors.length > 0}
                            aria-describedby="api-key-name-errors"
                          />
                          <div
                            id="api-key-name-errors"
                            className="text-destructive"
                          >
                            {field.state.meta.errors.map((error) => (
                              <p key={error?.message}>{error?.message}</p>
                            ))}
                          </div>
                        </div>
                      )}
                    </form.Field>
                    <form.Field name="expiry">
                      {(field) => (
                        <div className="flex flex-col gap-2">
                          <Label htmlFor="api-key-expiry">Expires</Label>
                          <Select
                            name={field.name}
                            items={expiryPresets}
                            value={field.state.value}
                            onValueChange={(value) => {
                              if (value) {
                                field.handleChange(value);
                              }
                            }}
                            disabled={busy}
                          >
                            <SelectTrigger
                              id="api-key-expiry"
                              onBlur={field.handleBlur}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {expiryPresets.map((preset) => (
                                  <SelectItem
                                    key={preset.value}
                                    value={preset.value}
                                  >
                                    {preset.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </form.Field>
                    <form.Field name="selected">
                      {(field) => (
                        <ApiKeyScopeField
                          value={field.state.value}
                          onChange={field.handleChange}
                          errors={field.state.meta.errors.map(
                            (error) => error?.message
                          )}
                          disabled={busy}
                          idPrefix="api-key"
                          picker={picker}
                        />
                      )}
                    </form.Field>
                    <form.Field name="permissions">
                      {(field) => (
                        <ApiKeyPermissionsField
                          value={field.state.value}
                          onChange={field.handleChange}
                          errors={field.state.meta.errors.map(
                            (error) => error?.message
                          )}
                          disabled={busy}
                          idPrefix="api-key"
                        />
                      )}
                    </form.Field>
                  </fieldset>
                )}
              </form.Subscribe>
              {submitError && (
                <p role="alert" className="text-destructive">
                  Couldn&apos;t create the API key. Try again.
                </p>
              )}
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(busy) => (
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
                      disabled={busy || !pickerReady}
                      aria-busy={busy}
                    >
                      {busy ? "Creating..." : "Create API key"}
                    </Button>
                  </DialogFooter>
                )}
              </form.Subscribe>
            </form>
          </>
        ) : (
          <OneTimeKey value={newKey} />
        )}
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(busy) => (
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className="absolute top-2 right-2"
                  size="icon-sm"
                  disabled={busy && newKey === null}
                />
              }
            >
              <XIcon aria-hidden="true" />
              <span className="sr-only">Close</span>
            </DialogClose>
          )}
        </form.Subscribe>
      </DialogContent>
    </Dialog>
  );
};
