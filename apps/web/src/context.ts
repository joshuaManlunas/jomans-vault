import { createContext as createApiContext } from "@jomans-vault/api/context";
import { parseMasterKey } from "@jomans-vault/crypto";

import { ENV } from "./env.server";
import { db, auth } from "./services";

let masterKey: Uint8Array | undefined;

export const createContext = async ({ req }: { req: Request }) => {
  masterKey ??= parseMasterKey(ENV.VAULT_MASTER_KEY);
  return await createApiContext({ db, auth, headers: req.headers, masterKey });
};

export type Context = Awaited<ReturnType<typeof createContext>>;
