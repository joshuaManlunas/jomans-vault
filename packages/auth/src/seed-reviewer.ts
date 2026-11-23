import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import type { Auth } from "./index";

const DEFAULT_EMAIL_ENV = "FACTORY_REVIEW_EMAIL";
const DEFAULT_PASSWORD_ENV = "FACTORY_REVIEW_PASSWORD";
const DEFAULT_REVIEWER_NAME = "Factory Reviewer";

export interface ReviewerEnvNames {
  emailEnv: string;
  passwordEnv: string;
}

export interface SeedReviewerOptions {
  auth: Auth;
  email: string;
  password: string;
  name?: string;
}

export interface SeedReviewerResult {
  action: "created" | "updated";
  userId: string;
}

/** Read a dotenv file the way the app does (comments, quotes, `export`); missing file reads as empty. */
export const readEnvFile = (envFilePath: string): NodeJS.Dict<string> =>
  existsSync(envFilePath) ? parseEnv(readFileSync(envFilePath, "utf-8")) : {};

export const readReviewerEnvNames = (configPath: string): ReviewerEnvNames => {
  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
    review_account?: {
      email_env?: string;
      password_env?: string;
    } | null;
  };
  const account = raw.review_account;
  return {
    emailEnv: account?.email_env?.trim() || DEFAULT_EMAIL_ENV,
    passwordEnv: account?.password_env?.trim() || DEFAULT_PASSWORD_ENV,
  };
};

export const seedReviewerAccount = async ({
  auth,
  email,
  password,
  name = DEFAULT_REVIEWER_NAME,
}: SeedReviewerOptions): Promise<SeedReviewerResult> => {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("Reviewer email must be non-empty");
  }
  if (!password) {
    throw new Error("Reviewer password must be non-empty");
  }

  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(normalizedEmail);

  if (!existing) {
    const created = await auth.api.signUpEmail({
      body: {
        email: normalizedEmail,
        name,
        password,
      },
    });
    return { action: "created", userId: created.user.id };
  }

  const passwordHash = await ctx.password.hash(password);
  const credentialAccount = await ctx.internalAdapter.findCredentialAccount(
    existing.user.id
  );
  await (credentialAccount
    ? ctx.internalAdapter.updatePassword(existing.user.id, passwordHash)
    : ctx.internalAdapter.linkAccount({
        accountId: existing.user.id,
        password: passwordHash,
        providerId: "credential",
        userId: existing.user.id,
      }));

  if (existing.user.name !== name) {
    await ctx.internalAdapter.updateUser(existing.user.id, { name });
  }

  return { action: "updated", userId: existing.user.id };
};
