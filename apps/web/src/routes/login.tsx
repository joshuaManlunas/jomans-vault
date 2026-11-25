import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";
import { safeReturnPath } from "@/lib/return-path";

const RouteComponent = () => {
  const { redirect, mode } = Route.useSearch();
  const [showSignIn, setShowSignIn] = useState(mode === "sign-in");

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
  validateSearch: (
    search: Record<string, unknown>
  ): { redirect?: string; mode?: "sign-in" } => ({
    redirect:
      typeof search.redirect === "string"
        ? safeReturnPath(search.redirect)
        : undefined,
    mode: search.mode === "sign-in" ? "sign-in" : undefined,
  }),
});
