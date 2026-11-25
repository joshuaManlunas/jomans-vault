import { OpenAPIGenerator } from "@orpc/openapi";
import type { OpenAPI } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";

import { appRouter } from "./routers/index";

export const openApiSchemaConverters = [new ZodToJsonSchemaConverter()];
export const openApiSpecOptions = { servers: [{ url: "/api/v1" }] };

export const generateOpenApiSpec = (): Promise<OpenAPI.Document> =>
  new OpenAPIGenerator({ schemaConverters: openApiSchemaConverters }).generate(
    appRouter,
    openApiSpecOptions
  );
