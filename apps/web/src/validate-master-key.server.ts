import "varlock/auto-load";
import { MasterKeyError, parseMasterKey } from "@jomans-vault/crypto";

import { ENV } from "./env.server";

try {
  parseMasterKey(ENV.VAULT_MASTER_KEY);
} catch (error) {
  if (!(error instanceof MasterKeyError)) {
    throw error;
  }
  process.stderr.write(`VAULT_MASTER_KEY is invalid: ${error.message}\n`);
  process.exit(1);
}
