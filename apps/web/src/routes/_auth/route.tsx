import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { getUser } from "@/functions/get-user";

const AuthLayout = () => <Outlet />;

export const Route = createFileRoute("/_auth")({
  component: AuthLayout,
  beforeLoad: async ({ location }) => {
    const session = await getUser();
    if (!session) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
      });
    }
    return { session };
  },
  loader: ({ context, location }) => {
    if (!context.session) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
      });
    }
  },
});
