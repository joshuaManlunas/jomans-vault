import { spawn } from "node:child_process";
import pathModule from "node:path";

import { plugin } from "varlock/plugin-lib";
import type { Resolver } from "varlock/plugin-lib";

const { SchemaError, ResolutionError } = plugin.ERRORS;
plugin.name = "jv";

interface Configuration {
  project: Resolver;
  environment: Resolver;
  cwd: string;
  exportPromise?: Promise<{
    project: string;
    environment: string;
    values: Record<string, string>;
  }>;
}
const configurations = new WeakMap<
  NonNullable<Resolver["dataSource"]>,
  Configuration
>();

const parseValues = (stdout: string): Record<string, string> => {
  let values: unknown;
  try {
    values = JSON.parse(stdout);
  } catch {
    throw new ResolutionError("jv export returned an unexpected response.");
  }
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    !Object.values(values).every((value) => typeof value === "string")
  ) {
    throw new ResolutionError("jv export returned an unexpected response.");
  }
  return values as Record<string, string>;
};

const runExport = (
  project: string,
  environment: string,
  cwd: string
): Promise<Record<string, string>> => {
  const { promise, resolve, reject } =
    Promise.withResolvers<Record<string, string>>();
  const child = spawn(
    "jv",
    ["export", "--project", project, "--env", environment],
    { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf-8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    reject(
      new ResolutionError(
        error.code === "ENOENT"
          ? "Could not run jv. Install the jv CLI and put it on PATH."
          : "Could not run jv export."
      )
    );
  });
  child.on("close", (code) => {
    if (code !== 0) {
      reject(
        new ResolutionError(stderr.trim() || `jv export failed (exit ${code}).`)
      );
      return;
    }
    try {
      resolve(parseValues(stdout));
    } catch (error) {
      reject(error);
    }
  });
  return promise;
};

const loadValues = async (config: Configuration) => {
  const project = await config.project.resolve();
  const environment = await config.environment.resolve();
  if (
    typeof project !== "string" ||
    !project ||
    typeof environment !== "string" ||
    !environment
  ) {
    throw new SchemaError("@initJv needs project and env.");
  }
  const values = await runExport(project, environment, config.cwd);
  return { project, environment, values };
};

plugin.registerRootDecorator({
  name: "initJv",
  isFunction: true,
  process(args) {
    const source = args.dataSource;
    if (
      !(source && "fullPath" in source && typeof source.fullPath === "string")
    ) {
      throw new SchemaError("@initJv must be declared in a schema file.");
    }
    if (configurations.has(source)) {
      throw new SchemaError("Use @initJv only once in the schema header.");
    }
    const project = args.objArgs?.project;
    const environment = args.objArgs?.env;
    if (!(project && environment)) {
      throw new SchemaError("@initJv needs project and env.");
    }
    if (
      args.arrArgs?.length ||
      Object.keys(args.objArgs ?? {}).some(
        (key) => key !== "project" && key !== "env"
      )
    ) {
      throw new SchemaError("Use @initJv(project=..., env=...).");
    }
    configurations.set(source, {
      project,
      environment,
      cwd: pathModule.dirname(source.fullPath),
    });
  },
});

plugin.registerResolverFunction({
  name: "jv",
  impliesSensitive: true,
  argsSchema: { type: "array", arrayMinLength: 0, arrayMaxLength: 1 },
  process() {
    const configuration =
      this.dataSource && configurations.get(this.dataSource);
    if (!configuration) {
      throw new SchemaError(
        "jv() needs @initJv(project=..., env=...) in the schema header."
      );
    }
    const argument = this.arrArgs?.[0];
    if (
      argument &&
      (!argument.isStatic || typeof argument.staticValue !== "string")
    ) {
      throw new SchemaError("jv() expects a static string key.");
    }
    // Varlock's built-in keychain resolver also reads the item's private parent.
    const parent: unknown = Reflect.get(this, "parent");
    const key =
      argument?.staticValue ??
      (parent && typeof parent === "object" && "key" in parent
        ? parent.key
        : undefined);
    if (typeof key !== "string") {
      throw new SchemaError("Use jv() on an item or provide jv(NAME).");
    }
    return { key, config: configuration };
  },
  async resolve({ key, config }) {
    config.exportPromise ??= loadValues(config);
    const { project, environment, values } = await config.exportPromise;
    if (!Object.hasOwn(values, key)) {
      throw new ResolutionError(
        `${key} is not in ${project}/${environment}. Add it with jv set ${key}.`
      );
    }
    return values[key];
  },
});
