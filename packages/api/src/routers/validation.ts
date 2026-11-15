import * as z from "zod";

export const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/u);

export const isUniqueViolation = (
  error: unknown,
  constraint: string
): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  if (
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  ) {
    return true;
  }
  return isUniqueViolation(error.cause, constraint);
};
