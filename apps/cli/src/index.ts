import { parseArgs } from "node:util";

import { findLink, resolveVaultUrl, validateSlug, writeLink } from "./config";
import { createCredentialStore } from "./credentials";
import type { CredentialStore } from "./credentials";
import { UsageError } from "./errors";
import { login } from "./login";
import { run } from "./run";

const usage = `Usage: jv link <project> --env <env> [--url <url>]
       jv run [--project <p>] [--env <e>] [--url <u>] -- <cmd> [args...]
       jv login [--url <url>] [--project <p>] [--env <e>] [--no-browser]
       jv --help
       jv help

Commands:
  login    Log this machine in to a vault
  link     Link this directory to a project and environment
  run      Start a command with vault values in its environment

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

const showHelp = (args: CliArgs): boolean => {
  const [command] = args.positionals;
  return (
    (command === "help" && args.positionals.length === 1) ||
    (Boolean(args.values.help) &&
      (!command || ["login", "link", "run"].includes(command)))
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
  command: "login" | "run",
  childCommand: string[],
  credentials: CredentialStore
): Promise<number> => {
  const link = await findLink(process.cwd());
  const project = args.values.project ?? link?.project;
  const environment = args.values.env ?? link?.env;
  if (command === "run" && (!project || !environment)) {
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
  return await login({
    url,
    project,
    environment,
    noBrowser: args.values["no-browser"] ?? false,
    env: process.env,
    credentials,
  });
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
    if (showHelp(args)) {
      console.info(usage);
      return 0;
    }
    if (args.values.project !== undefined) {
      validateSlug(args.values.project);
    }
    if (args.values.env !== undefined) {
      validateSlug(args.values.env);
    }
    if (command === "link") {
      return await linkDirectory(args, separator);
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
