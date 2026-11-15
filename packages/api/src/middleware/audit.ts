import { auditEvent } from "@jomans-vault/db/schema/vault";

import type { Context, Principal } from "../context";
import { o } from "../index";

export type AuditAction =
  | "project.create"
  | "project.delete"
  | "environment.create"
  | "environment.delete"
  | "secret.write"
  | "secret.reveal";
export interface AuditTarget {
  projectId: string;
  environmentId?: string;
  secretId?: string;
}

type AuthedContext = Context & { principal: Principal };

export const audit = <TOutput>(
  action: AuditAction,
  target: (args: { context: AuthedContext; output: TOutput }) => AuditTarget
) =>
  o.$context<AuthedContext>().middleware<{ db: Context["db"] }, unknown>(
    async ({ context, next: runHandler }) =>
      await context.db.transaction(async (transaction) => {
        const result = await runHandler({ context: { db: transaction } });
        await transaction.insert(auditEvent).values({
          ...target({ context, output: result.output }),
          action,
          actorType: "user",
          actorId: context.principal.user.id,
          ip: context.ip,
          userAgent: context.userAgent,
        });
        return result;
      })
  );
