import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { MasterKeyError, parseMasterKey } from "@jomans-vault/crypto";

if (existsSync(".env")) {
  loadEnvFile();
}
try {
  parseMasterKey(process.env.VAULT_MASTER_KEY);
} catch (error) {
  if (!(error instanceof MasterKeyError)) {
    throw error;
  }
  process.stderr.write(`VAULT_MASTER_KEY is invalid: ${error.message}\n`);
  process.exit(1);
}
