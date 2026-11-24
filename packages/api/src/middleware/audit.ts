import { auditEvent } from "@jomans-vault/db/schema/vault";

import type { Context, Principal } from "../context";
import { o } from "../index";

export type AuditAction =
  | "project.create"
  | "project.delete"
  | "environment.create"
  | "environment.delete"
  | "secret.rollback"
  | "secret.write"
  | "secret.delete"
  | "secret.export"
  | "secret.reveal"
  | "apikey.create"
  | "apikey.revoke";
export interface AuditTarget {
  projectId: string;
  environmentId?: string;
  secretId?: string;
}

export interface ApiKeyAuditTarget {
  apiKeyId: string;
}

export const recordAuditEvent = async (
  db: Context["db"],
  context: Pick<Context, "ip" | "userAgent"> & { principal: Principal },
  action: AuditAction,
  target: AuditTarget | ApiKeyAuditTarget
): Promise<void> => {
  await db.insert(auditEvent).values({
    ...target,
    action,
    actorType: context.principal.type,
    actorId:
      context.principal.type === "user"
        ? context.principal.user.id
        : context.principal.keyId,
    ip: context.ip,
    userAgent: context.userAgent,
  });
};

type AuthedContext = Context & {
  principal: Principal;
  project?: { id: string };
  environment?: { id: string } | null;
};

export const audit = <TOutput>(
  action: AuditAction,
  target: (args: { context: AuthedContext; output: TOutput }) => AuditTarget
) =>
  o.$context<AuthedContext>().middleware<{ db: Context["db"] }, unknown>(
    async ({ context, next: runHandler }) =>
      await context.db.transaction(async (transaction) => {
        const result = await runHandler({ context: { db: transaction } });
        await recordAuditEvent(
          transaction,
          context,
          action,
          target({ context, output: result.output })
        );
        return result;
      })
  );
