import type { Session } from "@jomans-vault/auth";
import type { Database } from "@jomans-vault/db";

export interface Context {
  session: Session | null;
  db: Database;
}
