import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";

import { baseOptions } from "@/lib/layout.shared";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <h1 className="mb-4 text-xl font-medium">Joman's Vault Docs</h1>
        <p className="text-fd-muted-foreground mb-6 px-4">
          A self-hosted secret store for developers and their coding agents.
        </p>
        <Link
          to="/docs/$"
          params={{
            _splat: "",
          }}
          className="bg-fd-primary text-fd-primary-foreground mx-auto rounded-lg px-3 py-2 text-sm font-medium"
        >
          Open Docs
        </Link>
      </div>
    </HomeLayout>
  );
}
