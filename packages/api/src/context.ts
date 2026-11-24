import type { Auth, Session } from "@jomans-vault/auth";
import type { Database } from "@jomans-vault/db";
import * as z from "zod";

export type KeyPermission = "read" | "reveal" | "inject" | "write" | "delete";

export interface ApiKeyScope {
  projects: Record<string, string[]>;
}

export type Principal =
  | { type: "user"; user: Session["user"] }
  | {
      type: "apiKey";
      keyId: string;
      userId: string;
      scope: ApiKeyScope;
      permissions: KeyPermission[];
    };

export const principalActor = (
  principal: Principal
): { type: Principal["type"]; id: string } => ({
  type: principal.type,
  id: principal.type === "user" ? principal.user.id : principal.keyId,
});

const scopeSchema = z.object({
  projects: z.record(z.string(), z.array(z.string())),
});
const permissionsSchema = z.object({ secrets: z.array(z.unknown()) });
const isKeyPermission = (value: unknown): value is KeyPermission =>
  value === "read" ||
  value === "reveal" ||
  value === "inject" ||
  value === "write" ||
  value === "delete";

const bearerPattern = /^Bearer\s+(?<key>.*)$/iu;

const authenticate = async (
  auth: Auth,
  headers: Headers
): Promise<Principal | null> => {
  const authorization = headers.get("Authorization");
  const bearerKey = authorization?.match(bearerPattern)?.groups?.key?.trim();
  const headerKey = headers.get("x-api-key")?.trim();
  if (bearerKey && headerKey && bearerKey !== headerKey) {
    return null;
  }
  const key = bearerKey || headerKey;
  if (key) {
    try {
      const result = await auth.api.verifyApiKey({ body: { key } });
      if (!(result.valid && result.key)) {
        return null;
      }
      const scope = scopeSchema.safeParse(result.key.metadata);
      const permissions = permissionsSchema.safeParse(result.key.permissions);
      return {
        type: "apiKey",
        keyId: result.key.id,
        userId: result.key.referenceId,
        scope: scope.success ? scope.data : { projects: {} },
        permissions: permissions.success
          ? permissions.data.secrets.filter(isKeyPermission)
          : [],
      };
    } catch {
      return null;
    }
  }
  const session = await auth.api.getSession({ headers });
  return session ? { type: "user", user: session.user } : null;
};

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface Context {
  auth: Auth;
  db: Database | Transaction;
  principal: Principal | null;
  masterKey: Uint8Array;
  ip: string | null;
  userAgent: string | null;
}

export const createContext = async ({
  db,
  auth,
  headers,
  masterKey,
}: {
  db: Database;
  auth: Auth;
  headers: Headers;
  masterKey: Uint8Array;
}): Promise<Context> => {
  const principal = await authenticate(auth, headers);
  return {
    auth,
    db,
    masterKey,
    ip:
      headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
      headers.get("X-Real-IP") ??
      null,
    userAgent: headers.get("User-Agent"),
    principal,
  };
};
