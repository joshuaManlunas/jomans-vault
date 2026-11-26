import { Button } from "@jomans-vault/ui/components/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@jomans-vault/ui/components/sheet";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, MenuIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ENV } from "@/env";
import { authClient } from "@/lib/auth-client";

import UserMenu from "./user-menu";

const navLinks = [
  { to: "/projects", label: "Projects" },
  { to: "/settings/api-keys", label: "API keys" },
  { to: "/audit", label: "Audit log" },
] as const;

const focusClass =
  "outline-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2";

const desktopNavLinkClass = `relative flex h-14 items-center px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground ${focusClass} after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:bg-foreground after:opacity-0 data-[status=active]:text-foreground data-[status=active]:after:opacity-100`;

const mobileNavRowClass = `relative flex h-12 items-center px-5 text-base font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground ${focusClass} before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:bg-foreground before:opacity-0 data-[status=active]:text-foreground data-[status=active]:before:opacity-100`;

const BrandMark = () => (
  <svg
    viewBox="4 8 24 16"
    className="h-4 w-6 shrink-0"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M8 8l8 8-8 8-4-4 4-4-4-4z" />
    <rect x="20" y="14" width="8" height="4" />
  </svg>
);

const Header = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { data: session, isPending } = authClient.useSession();
  const [openPathname, setOpenPathname] = useState<string | null>(null);

  const user = session?.user ?? null;
  const isLoginPage = pathname === "/login";
  const docsUrl = ENV.VITE_DOCS_URL;
  const mobileOpen = openPathname === pathname;

  const setMobileOpen = (open: boolean) => {
    setOpenPathname(open ? pathname : null);
  };

  useEffect(() => {
    if (!mobileOpen) {
      return;
    }

    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setOpenPathname(null);
      }
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [mobileOpen]);

  const handleSignOut = () => {
    setMobileOpen(false);
    authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          queryClient.clear();
          navigate({ to: "/" });
        },
      },
    });
  };

  const displayName = user ? user.name.trim() || user.email : "";

  return (
    <header className="bg-background/90 sticky top-0 z-40 border-b backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5 sm:px-8">
        <Link
          to="/"
          className={`text-foreground flex h-11 shrink-0 items-center gap-2.5 ${focusClass}`}
        >
          <BrandMark />
          <span className="text-[0.9375rem] font-semibold tracking-[-0.01em] max-[359px]:sr-only">
            Joman’s Vault
          </span>
        </Link>

        {user && (
          <nav aria-label="Primary" className="hidden items-center md:flex">
            {navLinks.map(({ to, label }) => (
              <Link key={to} to={to} className={desktopNavLinkClass}>
                {label}
              </Link>
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${
                user ? "hidden md:inline-flex" : "inline-flex"
              } text-muted-foreground hover:text-foreground h-14 items-center gap-1 px-3 text-sm font-medium transition-colors ${focusClass}`}
            >
              Docs
              <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
              <span className="sr-only">(opens in new tab)</span>
            </a>
          )}

          <UserMenu
            user={user}
            isPending={isPending}
            hideSignIn={isLoginPage}
            onSignOut={handleSignOut}
          />

          {user && (
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                render={
                  <button
                    type="button"
                    aria-label="Open menu"
                    className={`text-foreground -mr-2.5 grid size-11 cursor-pointer place-items-center md:hidden ${focusClass}`}
                  />
                }
              >
                <MenuIcon className="size-5" aria-hidden="true" />
              </SheetTrigger>
              <SheetContent
                side="top"
                showCloseButton={false}
                className="max-h-svh overflow-y-auto text-sm motion-reduce:transition-none"
              >
                <SheetTitle className="sr-only">Menu</SheetTitle>
                <div className="flex h-14 items-center justify-between px-5">
                  <div className="text-foreground flex items-center gap-2.5">
                    <BrandMark />
                    <span className="text-[0.9375rem] font-semibold tracking-[-0.01em]">
                      Joman’s Vault
                    </span>
                  </div>
                  <SheetClose
                    render={
                      <button
                        type="button"
                        aria-label="Close menu"
                        className={`text-foreground -mr-2.5 grid size-11 cursor-pointer place-items-center ${focusClass}`}
                      />
                    }
                  >
                    <XIcon className="size-5" aria-hidden="true" />
                  </SheetClose>
                </div>

                <nav aria-label="Mobile navigation">
                  <ul className="divide-y border-y">
                    {navLinks.map(({ to, label }) => (
                      <li key={to}>
                        <Link
                          to={to}
                          onClick={() => setMobileOpen(false)}
                          className={mobileNavRowClass}
                        >
                          {label}
                        </Link>
                      </li>
                    ))}
                    {docsUrl && (
                      <li>
                        <a
                          href={docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setMobileOpen(false)}
                          className={`text-muted-foreground hover:bg-muted/50 hover:text-foreground flex h-12 items-center justify-between px-5 text-base font-medium transition-colors ${focusClass}`}
                        >
                          <span>Docs</span>
                          <ArrowUpRightIcon
                            className="size-4"
                            aria-hidden="true"
                          />
                          <span className="sr-only">(opens in new tab)</span>
                        </a>
                      </li>
                    )}
                  </ul>
                </nav>

                <div className="flex items-center justify-between gap-3 p-5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {displayName}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {user.email}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 shrink-0 rounded-md px-4 text-sm"
                    onClick={handleSignOut}
                  >
                    Sign out
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;
