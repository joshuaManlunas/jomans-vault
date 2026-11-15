import { slug } from "@jomans-vault/api/routers/validation";
import { z } from "zod";

export const slugField = (emptyMessage: string): z.ZodType<string, string> =>
  z.string().superRefine((value, context) => {
    const result = slug.safeParse(value);
    if (result.success) {
      return;
    }
    const [issue] = result.error.issues;
    let message = "Use only lowercase letters, digits and hyphens.";
    if (issue?.code === "too_small") {
      message = emptyMessage;
    } else if (issue?.code === "too_big") {
      message = "Use 64 characters or fewer.";
    }
    context.addIssue({ code: "custom", message });
  });
