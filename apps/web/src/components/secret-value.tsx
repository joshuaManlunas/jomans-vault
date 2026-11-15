import { Button } from "@jomans-vault/ui/components/button";
import { ORPCError } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { client, orpc } from "@/utils/orpc";

const MASK = "••••••••";
const messages = {
  missing: "This secret no longer exists.",
  changed: "This secret changed. Reveal it again to see the latest value.",
  other: "Couldn't reveal this value. Try again.",
};

const SecretValueControl = ({
  project,
  env,
  secretKey,
  version,
  onChanged,
}: {
  project: string;
  env: string;
  secretKey: string;
  version: number;
  onChanged: (changed: boolean) => void;
}) => {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"missing" | "other" | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: orpc.secrets.list.key({ input: { project, env } }),
    });

  const toggle = async () => {
    if (request.current) {
      return;
    }
    setError(null);
    onChanged(false);
    if (value !== null) {
      setValue(null);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      const result = await client.secrets.get(
        { project, env, key: secretKey },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) {
        return;
      }
      if (result.version === version) {
        setValue(result.value);
      } else {
        onChanged(true);
        await refresh();
      }
    } catch (error_) {
      if (controller.signal.aborted) {
        return;
      }
      if (error_ instanceof ORPCError && error_.code === "NOT_FOUND") {
        setError("missing");
        await refresh();
      } else {
        setError("other");
      }
    }
    request.current = null;
    if (!controller.signal.aborted) {
      setPending(false);
    }
  };

  let buttonText = "Reveal";
  if (pending) {
    buttonText = "Revealing...";
  } else if (value !== null) {
    buttonText = "Hide";
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <div className="flex w-full min-w-0 flex-wrap items-start gap-2">
        {value === null ? (
          <span>
            <span aria-hidden="true">{MASK}</span>
            <span className="sr-only">Hidden value</span>
          </span>
        ) : (
          <span className="min-w-0 font-mono wrap-anywhere whitespace-pre-wrap">
            {value}
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          aria-busy={pending}
          aria-label={`${value === null ? "Reveal" : "Hide"} ${secretKey}`}
          onClick={toggle}
        >
          {buttonText}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {messages[error]}
        </p>
      )}
    </div>
  );
};

export const SecretValue = ({
  project,
  env,
  secretKey,
  version,
}: {
  project: string;
  env: string;
  secretKey: string;
  version: number;
}) => {
  const [changed, setChanged] = useState(false);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <SecretValueControl
        key={`${project}/${env}/${secretKey}/${version}`}
        project={project}
        env={env}
        secretKey={secretKey}
        version={version}
        onChanged={setChanged}
      />
      {changed && (
        <p role="alert" className="text-destructive">
          {messages.changed}
        </p>
      )}
    </div>
  );
};
