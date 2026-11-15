import { appRouter } from "@jomans-vault/api/routers/index";
import { RPCHandler } from "@orpc/server/fetch";
import { createFileRoute } from "@tanstack/react-router";

import { createContext } from "../../../context";

const rpcHandler = new RPCHandler(appRouter);

const handle = async ({ request }: { request: Request }) => {
  const rpcResult = await rpcHandler.handle(request, {
    prefix: "/api/rpc",
    context: await createContext({ req: request }),
  });
  const response =
    rpcResult.response ?? new Response("Not found", { status: 404 });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

export const Route = createFileRoute("/api/rpc/$")({
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
