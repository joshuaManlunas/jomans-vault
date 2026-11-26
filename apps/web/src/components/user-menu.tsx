import { buttonVariants } from "@jomans-vault/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@jomans-vault/ui/components/dropdown-menu";
import { Skeleton } from "@jomans-vault/ui/components/skeleton";
import { Link } from "@tanstack/react-router";

import { getUserInitials } from "@/lib/header";

export interface HeaderUser {
  name: string;
  email: string;
}

interface UserMenuProps {
  user: HeaderUser | null;
  isPending: boolean;
  hideSignIn: boolean;
  onSignOut: () => void;
}

const UserMenu = ({
  user,
  isPending,
  hideSignIn,
  onSignOut,
}: UserMenuProps) => {
  if (isPending) {
    return (
      <div className="flex min-w-18 justify-end">
        <Skeleton className="size-8 rounded-md" />
      </div>
    );
  }

  if (!user) {
    if (hideSignIn) {
      return null;
    }

    return (
      <div className="flex min-w-18 justify-end">
        <Link
          to="/login"
          search={{ mode: "sign-in" }}
          className={buttonVariants({
            variant: "outline",
            className: "h-9 rounded-md px-3.5 text-sm",
          })}
        >
          Sign in
        </Link>
      </div>
    );
  }

  const displayName = user.name.trim() || user.email;
  const initials = getUserInitials(user.name, user.email);

  return (
    <div className="hidden min-w-18 justify-end md:flex">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`Account: ${displayName}`}
              className="group focus-visible:outline-ring grid size-11 cursor-pointer place-items-center outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
            />
          }
        >
          <span
            aria-hidden="true"
            className="bg-secondary text-foreground group-hover:bg-accent group-aria-expanded:bg-accent grid size-8 place-items-center rounded-md text-xs font-medium transition-colors"
          >
            {initials}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-64">
          <div className="px-3 py-2.5">
            <p className="truncate text-sm font-medium">{displayName}</p>
            <p className="text-muted-foreground truncate text-xs">
              {user.email}
            </p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="min-h-10 cursor-pointer px-3 text-sm"
            onClick={onSignOut}
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default UserMenu;
