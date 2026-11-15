import { createContext as createApiContext } from "@jomans-vault/api/context";

import { db, auth } from "./services";

export const createContext = async ({ req }: { req: Request }) =>
  await createApiContext({ db, auth, headers: req.headers });

export type Context = Awaited<ReturnType<typeof createContext>>;
