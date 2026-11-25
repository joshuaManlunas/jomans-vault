import { parseArgs } from "node:util";

import { resolveVaultUrl } from "./config";
import { createCredentialStore } from "./credentials";
import { UsageError } from "./errors";
import { login } from "./login";

const usage = `Usage: jv login [--url <url>] [--no-browser]
       jv --help
       jv help

Commands:
  login    Log this machine in to a vault

Flags:
  --url <url>    Vault URL (otherwise JV_URL or the last login URL)
  --no-browser   Print the approval link without opening a browser
  --help         Show this help`;

const main = async (): Promise<number> => {
  if (process.env.JV_TEST_KEYCHAIN) {
    console.error(
      "warning: JV_TEST_KEYCHAIN is set; using a test keychain instead of the OS keychain. Never set it outside tests."
    );
  }
  try {
    const credentials = createCredentialStore(process.env);
    let args;
    try {
      args = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
          url: { type: "string" },
          "no-browser": { type: "boolean" },
          help: { type: "boolean" },
        },
      });
    } catch {
      throw new UsageError(usage);
    }
    const [command] = args.positionals;
    if (
      (command === "help" && args.positionals.length === 1) ||
      (args.values.help && (!command || command === "login"))
    ) {
      console.info(usage);
      return 0;
    }
    if (command !== "login" || args.positionals.length !== 1) {
      throw new UsageError(usage);
    }
    const url = await resolveVaultUrl({
      flag: args.values.url,
      env: process.env,
    });
    return await login({
      url,
      noBrowser: args.values["no-browser"] ?? false,
      env: process.env,
      credentials,
    });
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    console.error(error instanceof Error ? error.message : "Login failed.");
    return 1;
  }
};

process.exitCode = await main();
