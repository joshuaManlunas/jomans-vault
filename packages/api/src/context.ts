import type { Auth, Session } from "@jomans-vault/auth";
import type { Database } from "@jomans-vault/db";

export interface Principal {
  type: "user";
  user: Session["user"];
}

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface Context {
  db: Database | Transaction;
  principal: Principal | null;
  masterKey: Uint8Array;
  ip: string | null;
  userAgent: string | null;
}

export const createContext = async ({
  db,
  auth,
  headers,
  masterKey,
}: {
  db: Database;
  auth: Auth;
  headers: Headers;
  masterKey: Uint8Array;
}): Promise<Context> => {
  const session = await auth.api.getSession({ headers });
  return {
    db,
    masterKey,
    ip:
      headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
      headers.get("X-Real-IP") ??
      null,
    userAgent: headers.get("User-Agent"),
    principal: session ? { type: "user", user: session.user } : null,
  };
};
