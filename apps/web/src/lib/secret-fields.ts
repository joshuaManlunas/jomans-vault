import {
  isReservedEnvName,
  reservedEnvNameMessage,
} from "@jomans-vault/api/reserved-env";
import { secretKey } from "@jomans-vault/api/routers/validation";
import { z } from "zod";

export const secretKeyField: z.ZodType<string, string> = z
  .string()
  .superRefine((value, context) => {
    const result = secretKey.safeParse(value);
    if (result.success) {
      if (isReservedEnvName(value)) {
        context.addIssue({
          code: "custom",
          message: reservedEnvNameMessage(value),
        });
      }
      return;
    }
    const [issue] = result.error.issues;
    let message =
      "Use capital letters, digits and underscores, starting with a letter or underscore.";
    if (issue?.code === "too_small") {
      message = "Enter a key.";
    } else if (issue?.code === "too_big") {
      message = "Use 255 characters or fewer.";
    }
    context.addIssue({ code: "custom", message });
  });

export const secretValueField: z.ZodType<string, string> = z
  .string()
  .refine((value) => new TextEncoder().encode(value).byteLength <= 65_536, {
    message: "This value is too large. Use 64 KiB or less.",
  });

export const SECRET_KINDS = ["secret", "env", "token"] as const;
