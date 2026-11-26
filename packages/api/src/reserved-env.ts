export const RESERVED_ENV_NAMES: readonly string[] = [
  "BASH_ENV",
  "BUN_OPTIONS",
  "ENV",
  "IFS",
  "JAVA_TOOL_OPTIONS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PERL5LIB",
  "PERL5OPT",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYLIB",
  "RUBYOPT",
  "ZDOTDIR",
];
export const RESERVED_ENV_PREFIXES: readonly string[] = ["DYLD_"];

export const isReservedEnvName = (name: string): boolean =>
  RESERVED_ENV_NAMES.includes(name) ||
  RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));

export const reservedEnvNameMessage = (name: string): string =>
  `${name} is reserved because it controls how programs start. Use a different name.`;
