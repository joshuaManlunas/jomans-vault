import type { Session } from "@jomans-vault/auth";
import type { Database } from "@jomans-vault/db";

export type Context = {
  session: Session | null;
  db: Database;
};
