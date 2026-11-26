import { timingSafeEqual } from "node:crypto";

import {
  decryptValue,
  encryptValue,
  generateDek,
  unwrapDek,
  wrapDek,
} from "@jomans-vault/crypto";
import { apikey } from "@jomans-vault/db/schema/auth";
import { loginRequest } from "@jomans-vault/db/schema/vault";
import { ORPCError } from "@orpc/server";
import { and, count, eq, gt, inArray, lt, sql } from "drizzle-orm";
import * as z from "zod";

import type { Context } from "../context";
import { publicProcedure, userProcedure } from "../index";
import { issueApiKey, permissionsInput, scopeInput } from "./api-keys";
import { slug } from "./validation";

export const loginRequestWindowMs = 10 * 60 * 1000;
export const perClientLoginRequestLimit = 20;
export const globalLoginRequestLimit = 500;
export const loginRequestGraceMs = 60 * 60 * 1000;
export const loginRequestCleanupBatch = 100;
const loginRequestLock = 904_202_601;
const pairingAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const pairingCodeLength = 8;
const maxPairingAttempts = 5;
const normalizePairingCode = (value: string) =>
  value.toUpperCase().replaceAll(/[\s-]/gu, "");
const generatePairingCode = () => {
  const limit = 256 - (256 % pairingAlphabet.length);
  let code = "";
  while (code.length < pairingCodeLength) {
    const bytes = crypto.getRandomValues(new Uint8Array(pairingCodeLength));
    for (const byte of bytes) {
      if (byte < limit && code.length < pairingCodeLength) {
        code += pairingAlphabet[byte % pairingAlphabet.length];
      }
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};
const lifetimeMs = 5 * 60 * 1000;
const idInput = z.object({ id: z.string() });
const summaryOutput = z.object({
  id: z.string(),
  machineName: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  project: z.string().nullable(),
  env: z.string().nullable(),
  status: z.enum(["pending", "approved", "denied", "expired"]),
});
type LoginRequest = typeof loginRequest.$inferSelect;
const clearedKey = {
  keyCiphertext: null,
  keyIv: null,
  wrappedDek: null,
  dekIv: null,
};
const expired = (row: LoginRequest) => Date.now() >= row.expiresAt.getTime();
const effectiveStatus = (
  row: LoginRequest
): z.infer<typeof summaryOutput>["status"] => {
  if (row.status === "denied") {
    return "denied";
  }
  if (row.status === "collected") {
    return "approved";
  }
  if (expired(row)) {
    return "expired";
  }
  return row.status === "approved" ? "approved" : "pending";
};
const summarize = (row: LoginRequest) => ({
  id: row.id,
  machineName: row.machineName,
  requestedAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  project: row.project,
  env: row.environment,
  status: effectiveStatus(row),
});
const hashSecret = async (value: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  ).toString("hex");
const lockRequest = async (
  db: Context["db"],
  id: string,
  pollingSecretHash?: string
) => {
  const [row] = await db
    .select()
    .from(loginRequest)
    .where(
      and(
        eq(loginRequest.id, id),
        pollingSecretHash === undefined
          ? undefined
          : eq(loginRequest.pollingSecretHash, pollingSecretHash)
      )
    )
    .for("update");
  if (!row) {
    throw new ORPCError("NOT_FOUND");
  }
  return row;
};
const requirePending = (row: LoginRequest) => {
  if (row.status !== "pending" || expired(row)) {
    throw new ORPCError("CONFLICT");
  }
};

export const loginRequestsRouter = {
  open: publicProcedure
    .errors({
      TOO_MANY_REQUESTS: {
        message: "Too many login requests. Try again later.",
      },
    })
    .route({ method: "POST", path: "/login-requests", successStatus: 201 })
    .input(
      z
        .object({
          machineName: z.string().trim().min(1).max(32),
          project: slug.optional(),
          env: slug.optional(),
        })
        .refine(
          (input) => input.env === undefined || input.project !== undefined
        )
    )
    .output(
      z.object({
        id: z.string(),
        pollingSecret: z.string(),
        pairingCode: z.string(),
        expiresAt: z.string(),
      })
    )
    .handler(async ({ context, input, errors }) => {
      const pollingSecret = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32))
      ).toString("base64url");
      const pairingCode = generatePairingCode();
      const pairingCodeHash = await hashSecret(
        normalizePairingCode(pairingCode)
      );
      const pollingSecretHash = await hashSecret(pollingSecret);
      const clientIp = context.ip?.slice(0, 64) ?? null;
      return await context.db.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(${loginRequestLock})`
        );
        const createdAt = new Date();
        const inWindow = gt(
          loginRequest.createdAt,
          new Date(createdAt.getTime() - loginRequestWindowMs)
        );
        const [globalCount] = await transaction
          .select({ total: count() })
          .from(loginRequest)
          .where(inWindow);
        const [clientCount] = await transaction
          .select({ total: count() })
          .from(loginRequest)
          .where(
            and(
              inWindow,
              sql`${loginRequest.clientIp} IS NOT DISTINCT FROM ${clientIp}`
            )
          );
        if (
          (globalCount?.total ?? 0) >= globalLoginRequestLimit ||
          (clientCount?.total ?? 0) >= perClientLoginRequestLimit
        ) {
          throw errors.TOO_MANY_REQUESTS();
        }
        const stale = transaction
          .select({ id: loginRequest.id })
          .from(loginRequest)
          .where(
            lt(
              loginRequest.expiresAt,
              new Date(createdAt.getTime() - loginRequestGraceMs)
            )
          )
          .limit(loginRequestCleanupBatch);
        await transaction
          .delete(loginRequest)
          .where(inArray(loginRequest.id, stale));
        const [row] = await transaction
          .insert(loginRequest)
          .values({
            machineName: input.machineName,
            project: input.project,
            environment: input.env,
            clientIp,
            pollingSecretHash,
            pairingCodeHash,
            createdAt,
            expiresAt: new Date(createdAt.getTime() + lifetimeMs),
          })
          .returning();
        if (!row) {
          throw new ORPCError("INTERNAL_SERVER_ERROR");
        }
        return {
          id: row.id,
          pollingSecret,
          pairingCode,
          expiresAt: row.expiresAt.toISOString(),
        };
      });
    }),

  read: userProcedure
    .route({ method: "GET", path: "/login-requests/{id}" })
    .input(idInput)
    .output(summaryOutput)
    .handler(async ({ context, input }) => {
      const [row] = await context.db
        .select()
        .from(loginRequest)
        .where(eq(loginRequest.id, input.id));
      if (!row) {
        throw new ORPCError("NOT_FOUND");
      }
      return summarize(row);
    }),
  approve: userProcedure
    .route({ method: "POST", path: "/login-requests/{id}/approve" })
    .input(
      idInput.extend({
        pairingCode: z.string().trim().min(1).max(64),
        scope: scopeInput,
        permissions: permissionsInput(["read", "inject"]),
      })
    )
    .output(summaryOutput)
    .handler(async ({ context, input }) => {
      let createdKeyId: string | undefined;
      try {
        const result = await context.db.transaction(async (transaction) => {
          const row = await lockRequest(transaction, input.id);
          requirePending(row);
          const suppliedHash = await hashSecret(
            normalizePairingCode(input.pairingCode)
          );
          const matches =
            row.pairingCodeHash !== null &&
            timingSafeEqual(
              Buffer.from(suppliedHash, "hex"),
              Buffer.from(row.pairingCodeHash, "hex")
            );
          if (!matches) {
            const failedPairingAttempts = row.failedPairingAttempts + 1;
            const denied = failedPairingAttempts >= maxPairingAttempts;
            await transaction
              .update(loginRequest)
              .set({
                failedPairingAttempts,
                status: denied ? "denied" : "pending",
              })
              .where(eq(loginRequest.id, row.id));
            return { mismatch: true as const, denied };
          }
          const created = await issueApiKey(
            context,
            {
              name: row.machineName,
              scope: input.scope,
              permissions: input.permissions,
            },
            transaction
          );
          createdKeyId = created.id;
          const dek = generateDek();
          const encrypted = await encryptValue(
            new TextEncoder().encode(created.key),
            dek
          );
          const wrapped = await wrapDek(dek, context.masterKey);
          if (expired(row)) {
            throw new Error("Login request expired during approval");
          }
          const [updated] = await transaction
            .update(loginRequest)
            .set({
              status: "approved",
              apiKeyId: created.id,
              keyCiphertext: Buffer.from(encrypted.ciphertext),
              keyIv: Buffer.from(encrypted.iv),
              wrappedDek: Buffer.from(wrapped.wrappedDek),
              dekIv: Buffer.from(wrapped.iv),
            })
            .where(eq(loginRequest.id, row.id))
            .returning();
          if (!updated) {
            throw new ORPCError("INTERNAL_SERVER_ERROR");
          }
          return { mismatch: false as const, summary: summarize(updated) };
        });
        if (result.mismatch) {
          if (result.denied) {
            throw new ORPCError("CONFLICT");
          }
          throw new ORPCError("PAIRING_CODE_MISMATCH", {
            status: 403,
            message: "The pairing code doesn't match.",
          });
        }
        return result.summary;
      } catch (error) {
        if (createdKeyId) {
          await context.db.delete(apikey).where(eq(apikey.id, createdKeyId));
          throw new ORPCError("INTERNAL_SERVER_ERROR");
        }
        throw error;
      }
    }),
  deny: userProcedure
    .route({ method: "POST", path: "/login-requests/{id}/deny" })
    .input(idInput)
    .output(summaryOutput)
    .handler(
      async ({ context, input }) =>
        await context.db.transaction(async (transaction) => {
          const row = await lockRequest(transaction, input.id);
          requirePending(row);
          await transaction
            .update(loginRequest)
            .set({ status: "denied" })
            .where(eq(loginRequest.id, row.id));
          return summarize({ ...row, status: "denied" });
        })
    ),
  poll: publicProcedure
    .route({ method: "POST", path: "/login-requests/{id}/poll" })
    .input(idInput.extend({ pollingSecret: z.string().min(1).max(256) }))
    .output(
      z.union([
        z.object({ status: z.literal("pending") }),
        z.object({ status: z.literal("denied") }),
        z.object({ status: z.literal("expired") }),
        z.object({ status: z.literal("approved"), key: z.string() }),
      ])
    )
    .handler(async ({ context, input }) => {
      const pollingSecretHash = await hashSecret(input.pollingSecret);
      return await context.db.transaction(async (transaction) => {
        const row = await lockRequest(transaction, input.id, pollingSecretHash);
        if (row.status === "collected") {
          throw new ORPCError("CONFLICT");
        }
        if (row.status === "denied") {
          return { status: "denied" as const };
        }
        const clearExpired = async () => {
          await transaction
            .update(loginRequest)
            .set(clearedKey)
            .where(eq(loginRequest.id, row.id));
          return { status: "expired" as const };
        };
        if (expired(row)) {
          return await clearExpired();
        }
        if (row.status === "pending") {
          return { status: "pending" as const };
        }
        if (!(row.keyCiphertext && row.keyIv && row.wrappedDek && row.dekIv)) {
          throw new ORPCError("INTERNAL_SERVER_ERROR");
        }
        const dek = await unwrapDek(
          { wrappedDek: row.wrappedDek, iv: row.dekIv },
          context.masterKey
        );
        if (expired(row)) {
          return await clearExpired();
        }
        const key = new TextDecoder().decode(
          await decryptValue(
            { ciphertext: row.keyCiphertext, iv: row.keyIv },
            dek
          )
        );
        await transaction
          .update(loginRequest)
          .set({ status: "collected", ...clearedKey })
          .where(eq(loginRequest.id, row.id));
        return { status: "approved" as const, key };
      });
    }),
};
