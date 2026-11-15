import type { Auth, Session } from "@jomans-vault/auth";
import type { Database } from "@jomans-vault/db";

export interface Principal {
  type: "user";
  user: Session["user"];
}

export interface Context {
  db: Database;
  principal: Principal | null;
}

export const createContext = async ({
  db,
  auth,
  headers,
}: {
  db: Database;
  auth: Auth;
  headers: Headers;
}): Promise<Context> => {
  const session = await auth.api.getSession({ headers });
  return {
    db,
    principal: session ? { type: "user", user: session.user } : null,
  };
};
