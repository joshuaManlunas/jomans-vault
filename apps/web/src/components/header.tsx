import { Link } from "@tanstack/react-router";

import { ENV } from "@/env";

import UserMenu from "./user-menu";

const Header = () => {
  const links = [
    { to: "/", label: "Home" },
    { to: "/projects", label: "Projects" },
    { to: "/settings/api-keys", label: "API keys" },
    { to: "/audit", label: "Audit log" },
  ] as const;

  return (
    <div>
      <div className="flex flex-row items-center justify-between px-2 py-1">
        <nav className="flex gap-4 text-lg">
          {links.map(({ to, label }) => (
            <Link key={to} to={to}>
              {label}
            </Link>
          ))}
          {ENV.VITE_DOCS_URL && (
            <a href={ENV.VITE_DOCS_URL} target="_blank" rel="noopener">
              Docs
            </a>
          )}
        </nav>
        <div className="flex items-center gap-2">
          <UserMenu />
        </div>
      </div>
      <hr />
    </div>
  );
};

export default Header;
