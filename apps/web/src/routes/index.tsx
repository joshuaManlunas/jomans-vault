import { createFileRoute } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import { SignedInHome } from "@/components/home/signed-in-home";
import { SignedOutHome } from "@/components/home/signed-out-home";
import { getUser } from "@/functions/get-user";

const subscribeToOrigin = () => () => {
  // A document's origin is fixed for its lifetime.
};
const getClientOrigin = () => window.location.origin;

// The public origin can match the auth URL that Varlock guards in SSR responses.
const getServerOrigin = () => "";

const HomeComponent = () => {
  const user = Route.useLoaderData();
  const origin = useSyncExternalStore(
    subscribeToOrigin,
    getClientOrigin,
    getServerOrigin
  );
  const loginCommand = origin ? `jv login --url ${origin}` : null;

  return user ? (
    <SignedInHome user={user} loginCommand={loginCommand} />
  ) : (
    <SignedOutHome loginCommand={loginCommand} mcpUrl={`${origin}/api/mcp`} />
  );
};

export const Route = createFileRoute("/")({
  loader: async () => {
    const session = await getUser();
    return session ? { id: session.user.id, name: session.user.name } : null;
  },
  component: HomeComponent,
});
