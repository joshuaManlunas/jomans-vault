import { parseArgs } from "node:util";

import { readRememberedUrl, resolveVaultUrl } from "./config";
import { createCredentialStore } from "./credentials";
import { UsageError } from "./errors";
import { login } from "./login";
import { logout } from "./logout";

const usage = `Usage: jv login [--url <url>] [--no-browser]
       jv logout [--url <url>]
       jv --help
       jv help

Commands:
  login    Log this machine in to a vault
  logout   Log this machine out: revoke its key and remove it

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
      command === "logout" &&
      (args.positionals.length !== 1 || args.values["no-browser"] !== undefined)
    ) {
      throw new UsageError(usage);
    }
    if (
      (command === "help" && args.positionals.length === 1) ||
      (args.values.help && [undefined, "", "login", "logout"].includes(command))
    ) {
      console.info(usage);
      return 0;
    }
    if (command === "logout") {
      const configured =
        args.values.url ??
        (process.env.JV_URL || (await readRememberedUrl(process.env)));
      return await logout({
        url:
          configured === null
            ? null
            : await resolveVaultUrl({
                flag: configured,
                env: process.env,
              }),
        credentials,
      });
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
