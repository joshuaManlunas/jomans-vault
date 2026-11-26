import { expect, test } from "bun:test";

import { secretKeyField } from "./secret-fields";

test.each([
  [
    "NODE_OPTIONS",
    "NODE_OPTIONS is reserved because it controls how programs start. Use a different name.",
  ],
  [
    "DYLD_INSERT_LIBRARIES",
    "DYLD_INSERT_LIBRARIES is reserved because it controls how programs start. Use a different name.",
  ],
  [
    "bad key",
    "Use capital letters, digits and underscores, starting with a letter or underscore.",
  ],
])("rejects %s inline", (key, message) => {
  const result = secretKeyField.safeParse(key);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues[0]?.message).toBe(message);
  }
});

test("accepts ordinary keys", () => {
  expect(secretKeyField.safeParse("API_TOKEN").success).toBe(true);
});
