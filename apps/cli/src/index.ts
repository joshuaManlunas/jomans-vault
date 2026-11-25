import { parseArgs } from "node:util";

import {
  findLink,
  readRememberedUrl,
  resolveVaultUrl,
  validateSlug,
  writeLink,
} from "./config";
import { createCredentialStore } from "./credentials";
import type { CredentialStore } from "./credentials";
import { UsageError } from "./errors";
import { login } from "./login";
import { logout } from "./logout";
import { mcp } from "./mcp";
import { run } from "./run";
import { get, history, ls, rm, set } from "./secrets";

const secretCommands = { ls, get, set, rm, history };
type SecretCommand = keyof typeof secretCommands;
const isSecretCommand = (
  command: string | undefined
): command is SecretCommand =>
  command !== undefined && Object.hasOwn(secretCommands, command);

const usage = `Usage: jv link <project> --env <env> [--url <url>]
       jv run [--project <p>] [--env <e>] [--url <u>] -- <cmd> [args...]
       jv login [--url <url>] [--project <p>] [--env <e>] [--no-browser]
       jv logout [--url <url>]
       jv mcp [--project <p>] [--env <e>] [--url <u>]
       jv ls [--project <p>] [--env <e>] [--url <u>]
       jv get <KEY> [--project <p>] [--env <e>] [--url <u>]
       jv set <KEY> [<value> | -] [--project <p>] [--env <e>] [--url <u>]
       jv rm <KEY> [--project <p>] [--env <e>] [--url <u>]
       jv history <KEY> [--project <p>] [--env <e>] [--url <u>]
       jv --help
       jv help

Commands:
  login    Log this machine in to a vault
  logout   Log this machine out: revoke its key and remove it
  link     Link this directory to a project and environment
  run      Start a command with vault values in its environment
  mcp      Serve run, list and set tools to an MCP client over stdio
  ls       List secret keys, kinds and versions
  get      Print only a secret value
  set      Store a secret value
  rm       Remove a secret without confirmation
  history  List a secret's versions

For set, - stores stdin unchanged, including a trailing newline.
Use printf '%s' to pipe a value without a trailing newline.

Flags:
  --url <url>    Vault URL (otherwise JV_URL, jv.json or the last login URL)
  --project <p>  Override the linked project
  --env <e>      Override the linked environment
  --no-browser   Print the approval link without opening a browser
  --help         Show this help`;

const parseCli = (argv: string[], separator: number) => {
  let args;
  try {
    args = parseArgs({
      args: separator === -1 ? argv : argv.slice(0, separator),
      allowPositionals: true,
      options: {
        url: { type: "string" },
        project: { type: "string" },
        env: { type: "string" },
        "no-browser": { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch {
    throw new UsageError(usage);
  }
  return args;
};
type CliArgs = ReturnType<typeof parseCli>;

const showHelp = (args: CliArgs, separator: number): boolean => {
  const [command] = args.positionals;
  if (command === "help") {
    return args.positionals.length === 1;
  }
  if (!args.values.help) {
    return false;
  }
  if (command === "logout") {
    return (
      args.positionals.length === 1 &&
      args.values["no-browser"] === undefined &&
      args.values.project === undefined &&
      args.values.env === undefined &&
      separator === -1
    );
  }
  return (
    !command ||
    ["login", "link", "run", "mcp", ...Object.keys(secretCommands)].includes(
      command
    )
  );
};

const linkDirectory = async (
  args: CliArgs,
  separator: number
): Promise<number> => {
  const [, project] = args.positionals;
  if (
    !project ||
    !args.values.env ||
    args.positionals.length !== 2 ||
    args.values.project !== undefined ||
    separator !== -1
  ) {
    throw new UsageError(usage);
  }
  validateSlug(project);
  const url =
    args.values.url === undefined
      ? undefined
      : await resolveVaultUrl({ flag: args.values.url, env: process.env });
  await writeLink(process.cwd(), { project, env: args.values.env, url });
  console.error(
    `Linked ${process.cwd()} to ${project}/${args.values.env}${url === undefined ? "" : ` at ${url}`}.`
  );
  return 0;
};

const linkedCommand = async (
  args: CliArgs,
  command: "login" | "run" | SecretCommand,
  childCommand: string[],
  credentials: CredentialStore
): Promise<number> => {
  const link = await findLink(process.cwd());
  const project = args.values.project ?? link?.project;
  const environment = args.values.env ?? link?.env;
  if (command !== "login" && (!project || !environment)) {
    throw new UsageError(
      "No project and environment. Run jv link <project> --env <env>, or pass --project and --env."
    );
  }
  if (environment && !project) {
    throw new UsageError(
      "An environment requires a project. Pass --project <p>."
    );
  }
  const url = await resolveVaultUrl({
    flag: args.values.url,
    env: process.env,
    linked: link?.url,
  });
  if (command === "run" && project && environment) {
    return await run({
      url,
      project,
      environment,
      command: childCommand,
      env: process.env,
      credentials,
    });
  }
  if (isSecretCommand(command) && project && environment) {
    if (command === "ls") {
      return await ls({ url, project, environment, credentials });
    }
    const [, key = "", value] = args.positionals;
    return await secretCommands[command]({
      url,
      project,
      environment,
      credentials,
      key,
      value,
    });
  }
  return await login({
    url,
    project,
    environment,
    noBrowser: args.values["no-browser"] ?? false,
    env: process.env,
    credentials,
  });
};

const validateSecretArgs = (
  args: CliArgs,
  command: SecretCommand,
  separator: number
) => {
  const count = args.positionals.length;
  let validCount = count === 2;
  if (command === "ls") {
    validCount = count === 1;
  } else if (command === "set") {
    validCount = count === 2 || count === 3;
  }
  if (args.values.help && count === 1) {
    validCount = true;
  }
  if (!validCount || separator !== -1 || args.values["no-browser"]) {
    throw new UsageError(usage);
  }
};

const logoutCommand = async (
  args: CliArgs,
  separator: number,
  credentials: CredentialStore
): Promise<number> => {
  if (
    args.positionals.length !== 1 ||
    args.values["no-browser"] !== undefined ||
    args.values.project !== undefined ||
    args.values.env !== undefined ||
    separator !== -1
  ) {
    throw new UsageError(usage);
  }
  const link = await findLink(process.cwd());
  const configured =
    args.values.url ??
    (process.env.JV_URL || link?.url || (await readRememberedUrl(process.env)));
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
};

const validateMcpArgs = (args: CliArgs, separator: number) => {
  if (
    args.positionals.length !== 1 ||
    separator !== -1 ||
    args.values["no-browser"] !== undefined
  ) {
    throw new UsageError(usage);
  }
};

const validateTargetFlags = (args: CliArgs) => {
  if (args.values.project !== undefined) {
    validateSlug(args.values.project);
  }
  if (args.values.env !== undefined) {
    validateSlug(args.values.env);
  }
};

const main = async (): Promise<number> => {
  if (process.env.JV_TEST_KEYCHAIN) {
    console.error(
      "warning: JV_TEST_KEYCHAIN is set; using a test keychain instead of the OS keychain. Never set it outside tests."
    );
  }
  try {
    const credentials = createCredentialStore(process.env);
    const argv = process.argv.slice(2);
    const separator = argv.indexOf("--");
    const args = parseCli(argv, separator);
    const [command] = args.positionals;
    if (isSecretCommand(command)) {
      validateSecretArgs(args, command, separator);
    }
    if (command === "mcp") {
      validateMcpArgs(args, separator);
    }
    if (showHelp(args, separator)) {
      console.info(usage);
      return 0;
    }
    if (command === "logout") {
      return await logoutCommand(args, separator, credentials);
    }
    validateTargetFlags(args);
    if (command === "mcp") {
      return await mcp({ flags: args.values, env: process.env, credentials });
    }
    if (command === "link") {
      return await linkDirectory(args, separator);
    }
    if (isSecretCommand(command)) {
      return await linkedCommand(args, command, [], credentials);
    }
    if (
      (command !== "login" && command !== "run") ||
      args.positionals.length !== 1 ||
      (command === "login" && separator !== -1) ||
      (command === "run" && (separator === -1 || separator === argv.length - 1))
    ) {
      throw new UsageError(usage);
    }
    return await linkedCommand(
      args,
      command,
      argv.slice(separator + 1),
      credentials
    );
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    console.error(error instanceof Error ? error.message : "Command failed.");
    return 1;
  }
};

process.exitCode = await main();
