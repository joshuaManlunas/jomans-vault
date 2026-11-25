import { parseMasterKey } from "@jomans-vault/crypto";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { ORPCError, call } from "@orpc/server";
import * as z from "zod";

import { createContext } from "./context";
import type { Context } from "./context";
import type { VaultApiHandler, VaultApiHandlerOptions } from "./handler";
import { secretsRouter } from "./routers/secrets";
import { secretKey, slug } from "./routers/validation";

const toolError = (error: unknown): CallToolResult => {
  let text = "Internal error";
  if (error instanceof ORPCError) {
    switch (error.code) {
      case "NOT_FOUND": {
        text = "Not found";
        break;
      }
      case "FORBIDDEN": {
        text = "Forbidden";
        break;
      }
      case "BAD_REQUEST": {
        text = "Invalid input";
        break;
      }
      default: {
        break;
      }
    }
  }
  return { isError: true, content: [{ type: "text", text }] };
};

const toolResult = (data: Record<string, unknown>): CallToolResult => ({
  structuredContent: data,
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const createServer = (context: Context): McpServer => {
  const server = new McpServer({ name: "jomans-vault", version: "1.0.0" });
  server.registerTool(
    "list_keys",
    {
      description:
        "List the key names in a project environment. Never returns values. Needs the read permission.",
      inputSchema: z.object({ project: slug, environment: slug }),
      outputSchema: z.object({
        keys: z.array(
          z.object({
            key: z.string(),
            kind: z.enum(["secret", "env", "token"]),
            version: z.number(),
            updatedAt: z.string(),
          })
        ),
      }),
    },
    async ({ project, environment }) => {
      try {
        const keys = await call(
          secretsRouter.list,
          { project, env: environment },
          { context }
        );
        return toolResult({ keys });
      } catch (error) {
        return toolError(error);
      }
    }
  );
  server.registerTool(
    "set_secret",
    {
      description:
        "Store a secret value in a project environment, creating the key or adding a new version. Never returns the value. Needs the write permission.",
      inputSchema: z.object({
        project: slug,
        environment: slug,
        key: secretKey,
        value: z.string(),
      }),
      outputSchema: z.object({ key: z.string(), version: z.number() }),
    },
    async ({ project, environment, key, value }) => {
      try {
        const result = await call(
          secretsRouter.set,
          { project, env: environment, key, value },
          { context }
        );
        return toolResult({ key: result.key, version: result.version });
      } catch (error) {
        return toolError(error);
      }
    }
  );
  return server;
};

const httpError = (status: number, code: number, message: string): Response =>
  Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status }
  );

const serveMcp = async (
  request: Request,
  context: Context
): Promise<Response> => {
  const factory = () => createServer(context);
  if (await isLegacyRequest(request)) {
    if (request.method !== "POST") {
      const response = httpError(405, -32_000, "Method not allowed.");
      response.headers.set("Allow", "POST");
      return response;
    }
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }
  const modern = createMcpHandler(factory, {
    responseMode: "json",
    legacy: "reject",
    // Listen streams ignore responseMode; refuse them before the SSE ack.
    maxSubscriptions: 0,
  });
  try {
    return await modern.fetch(request);
  } finally {
    await modern.close();
  }
};

export const createVaultMcpHandler = ({
  db,
  auth,
  masterKey,
}: VaultApiHandlerOptions): VaultApiHandler => {
  const parsedMasterKey = parseMasterKey(masterKey);
  return async (request) => {
    let response: Response;
    if (request.headers.has("Origin")) {
      response = httpError(403, -32_600, "Forbidden");
    } else {
      const context = await createContext({
        db,
        auth,
        headers: request.headers,
        masterKey: parsedMasterKey,
      });
      response =
        context.principal?.type === "apiKey"
          ? await serveMcp(request, context)
          : httpError(401, -32_001, "Unauthorized");
    }
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
};
