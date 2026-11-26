import { expect, test } from "bun:test";

import {
  isReservedEnvName,
  RESERVED_ENV_NAMES,
  reservedEnvNameMessage,
} from "./reserved-env";

test.each([...RESERVED_ENV_NAMES, "DYLD_INSERT_LIBRARIES"])(
  "%s is reserved",
  (name) => {
    expect(isReservedEnvName(name)).toBe(true);
    expect(reservedEnvNameMessage(name)).toBe(
      `${name} is reserved because it controls how programs start. Use a different name.`
    );
  }
);

test.each(["DYLD", "MY_PATH", "PATH_PREFIX", "NODE_ENV", "path"])(
  "%s is ordinary",
  (name) => {
    expect(isReservedEnvName(name)).toBe(false);
  }
);
