import { createVaultMcpHandler } from "@jomans-vault/api/mcp";
import { createFileRoute } from "@tanstack/react-router";

import { ENV } from "../../env.server";
import { db, auth } from "../../services";

const handler = createVaultMcpHandler({
  db,
  auth,
  masterKey: ENV.VAULT_MASTER_KEY,
});
const handle = ({ request }: { request: Request }) => handler(request);

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: handle,
      GET: handle,
      DELETE: handle,
    },
  },
});
