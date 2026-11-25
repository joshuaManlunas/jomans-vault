import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";
import { safeReturnPath } from "@/lib/return-path";

const RouteComponent = () => {
  const { redirect } = Route.useSearch();
  const [showSignIn, setShowSignIn] = useState(false);

  return showSignIn ? (
    <SignInForm
      redirect={redirect}
      onSwitchToSignUp={() => setShowSignIn(false)}
    />
  ) : (
    <SignUpForm
      redirect={redirect}
      onSwitchToSignIn={() => setShowSignIn(true)}
    />
  );
};

export const Route = createFileRoute("/login")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect:
      typeof search.redirect === "string"
        ? safeReturnPath(search.redirect)
        : undefined,
  }),
});
