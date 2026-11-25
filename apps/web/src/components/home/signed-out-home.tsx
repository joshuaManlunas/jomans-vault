import { buttonVariants } from "@jomans-vault/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { orpc } from "@/utils/orpc";

import { SealedEnv } from "./sealed-env";

const ApiHealth = () => {
  const healthCheck = useQuery(orpc.healthCheck.queryOptions());
  const connected = healthCheck.isSuccess;

  let status = "Checking API";
  if (connected) {
    status = "API connected";
  } else if (healthCheck.isError) {
    status = "API unreachable";
  }

  return (
    <footer className="border-t py-6">
      <output className="text-muted-foreground flex items-center gap-2 text-sm">
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${healthCheck.isError ? "bg-destructive" : "bg-foreground"}`}
        />
        {status}
      </output>
    </footer>
  );
};

export const SignedOutHome = ({
  loginCommand,
  mcpUrl,
}: {
  loginCommand: string | null;
  mcpUrl: string;
}) => {
  const destinations = [
    {
      title: "Your terminal",
      description: (
        <>
          Use the <code className="font-mono">jv</code> CLI to inject values
          with <code className="font-mono">jv run</code> or resolve them in
          Varlock with <code className="font-mono">jv()</code>.
        </>
      ),
      snippet: loginCommand ?? "jv login --url <origin>",
    },
    {
      title: "Your agents",
      description:
        "Connect an MCP client with a scoped API key to list secret metadata or store values.",
      snippet: mcpUrl,
    },
    {
      title: "Your record",
      description:
        "Review actions in the audit log, inspect a secret’s version history, and roll back to an earlier version.",
      snippet: "jv history DATABASE_URL",
    },
  ];

  return (
    <main className="mx-auto flex w-full max-w-6xl min-w-0 flex-col px-5 sm:px-8">
      <section className="grid items-center gap-9 pt-12 pb-14 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] md:gap-8 md:pt-20 md:pb-20 lg:gap-14">
        <div>
          <h1 className="max-w-[19ch] text-4xl leading-[1.06] font-semibold tracking-[-0.02em] text-balance md:text-[3.25rem] lg:text-[3.5rem]">
            Secrets stay sealed until your process asks for them.
          </h1>
          <p className="text-muted-foreground mt-5 max-w-[65ch] text-base leading-relaxed">
            A master key protects each project’s encryption key, and the vault
            decrypts values only when you or an authorized API key requests
            them.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              to="/login"
              search={{ mode: "sign-in" }}
              className={buttonVariants({
                size: "lg",
                className:
                  "h-10 rounded-md px-4 text-sm focus-visible:ring-ring",
              })}
            >
              Sign in
            </Link>
            <Link
              to="/login"
              className={buttonVariants({
                variant: "outline",
                size: "lg",
                className:
                  "h-10 rounded-md px-4 text-sm focus-visible:ring-ring",
              })}
            >
              Create account
            </Link>
          </div>
        </div>
        <SealedEnv />
      </section>

      <section aria-labelledby="secret-destinations">
        <h2
          id="secret-destinations"
          className="mb-5 text-2xl font-semibold tracking-tight"
        >
          Where your secrets go
        </h2>
        {destinations.map(({ title, description, snippet }) => (
          <div
            key={title}
            className="grid gap-2 border-t py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-8"
          >
            <h3 className="text-lg font-medium">{title}</h3>
            <div className="min-w-0">
              <p className="text-muted-foreground max-w-[65ch] text-base leading-relaxed">
                {description}
              </p>
              <code className="mt-2 block font-mono text-sm wrap-anywhere">
                {snippet}
              </code>
            </div>
          </div>
        ))}
      </section>

      <ApiHealth />
    </main>
  );
};
