import type { Auth } from "@jomans-vault/auth";
import { parseMasterKey } from "@jomans-vault/crypto";
import type { Database } from "@jomans-vault/db";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";

import { createContext } from "./context";
import { appRouter } from "./routers/index";

export interface VaultApiHandlerOptions {
  db: Database;
  auth: Auth;
  /** Raw base64 value of VAULT_MASTER_KEY. Validated with parseMasterKey. */
  masterKey: string | undefined;
}

export type VaultApiHandler = (request: Request) => Promise<Response>;

export const createVaultApiHandler = ({
  db,
  auth,
  masterKey,
}: VaultApiHandlerOptions): VaultApiHandler => {
  const parsedMasterKey = parseMasterKey(masterKey);
  const handler = new OpenAPIHandler(appRouter, {
    plugins: [
      new OpenAPIReferencePlugin({
        schemaConverters: [new ZodToJsonSchemaConverter()],
        specGenerateOptions: { servers: [{ url: "/api/v1" }] },
      }),
    ],
  });

  return async (request) => {
    const { response } = await handler.handle(request, {
      prefix: "/api/v1",
      context: await createContext({
        db,
        auth,
        headers: request.headers,
        masterKey: parsedMasterKey,
      }),
    });
    const result = response ?? new Response("Not found", { status: 404 });
    result.headers.set("Cache-Control", "private, no-store");
    return result;
  };
};
