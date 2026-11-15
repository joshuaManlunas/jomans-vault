import { createVaultApiHandler } from "@jomans-vault/api/handler";
import { createFileRoute } from "@tanstack/react-router";

import { ENV } from "../../../env.server";
import { db, auth } from "../../../services";

const handler = createVaultApiHandler({
  db,
  auth,
  masterKey: ENV.VAULT_MASTER_KEY,
});
const handle = ({ request }: { request: Request }) => handler(request);

export const Route = createFileRoute("/api/v1/$")({
  server: {
    handlers: {
      HEAD: handle,
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
    },
  },
});
