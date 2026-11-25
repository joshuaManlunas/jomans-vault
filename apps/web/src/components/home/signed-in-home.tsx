import { Button } from "@jomans-vault/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { orpc } from "@/utils/orpc";

const nameSeparator = /\s+/u;

export const SignedInHome = ({
  user,
  loginCommand,
}: {
  user: { id: string; name: string };
  loginCommand: string | null;
}) => {
  const projects = useQuery(
    orpc.projects.list.queryOptions({
      queryKey: [...orpc.projects.list.key(), { userId: user.id }],
    })
  );
  const count = projects.data?.length;
  const destinations = [
    {
      to: "/projects",
      title: "Projects",
      description:
        count === undefined
          ? "Manage environments and their secrets."
          : `${count} ${count === 1 ? "project" : "projects"} in your vault.`,
    },
    {
      to: "/settings/api-keys",
      title: "API keys",
      description: "Manage scoped access for machines and agents.",
    },
    {
      to: "/audit",
      title: "Audit log",
      description: "Review activity across your vault.",
    },
  ] as const;

  const copyCommand = async () => {
    if (!loginCommand) {
      return;
    }

    try {
      await navigator.clipboard.writeText(loginCommand);
      toast.success("Copied");
    } catch {
      toast.error("Couldn’t copy the command.");
    }
  };

  return (
    <main className="mx-auto w-full max-w-3xl min-w-0 px-5 pt-12 pb-12 sm:px-8 md:pt-20">
      <h1 className="mb-8 text-4xl font-semibold tracking-[-0.02em] wrap-anywhere md:text-5xl">
        Welcome back, {user.name.trim().split(nameSeparator, 1)[0] || user.name}
      </h1>
      <nav aria-label="Vault destinations">
        <ul className="divide-y border-y">
          {destinations.map(({ to, title, description }) => (
            <li key={to}>
              <Link
                to={to}
                className="hover:bg-muted/50 focus-visible:outline-ring block px-3 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 sm:px-4"
              >
                <span className="block text-lg font-medium">{title}</span>
                <span className="text-muted-foreground mt-1 block text-sm">
                  {description}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section aria-labelledby="connect-machine" className="mt-11">
        <h2
          id="connect-machine"
          className="text-2xl font-semibold tracking-tight"
        >
          Connect a machine
        </h2>
        <div className="bg-card mt-4 flex min-h-[4.125rem] items-center justify-between gap-3 rounded-lg border p-3 sm:min-h-0 sm:pl-4">
          <code className="min-w-0 font-mono text-sm wrap-anywhere">
            {loginCommand ?? "jv login --url <origin>"}
          </code>
          <Button
            type="button"
            variant="outline"
            className="focus-visible:ring-ring rounded-md"
            disabled={!loginCommand}
            onClick={copyCommand}
          >
            Copy
          </Button>
        </div>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
          <code className="font-mono">/api/mcp</code> accepts the same scoped
          API keys for the operations their permissions allow.
        </p>
      </section>
    </main>
  );
};
