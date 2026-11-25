import { generateOpenApiSpec } from "@jomans-vault/api/openapi";
import type { Document } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

export const openapi = createOpenAPI({
  input: {
    // oRPC types the OpenAPI version as string; Fumadocs uses version literals.
    vault: async () => (await generateOpenApiSpec()) as Document,
  },
});
