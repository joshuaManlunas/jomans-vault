export class DotenvValueError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Secret ${key} cannot be exported as dotenv; use format=json`);
    this.name = "DotenvValueError";
    this.key = key;
  }
}

// Private copy of dotenv 17.4.2's LINE expression and parse steps.
const LINE =
  // oxlint-disable-next-line prefer-named-capture-group, require-unicode-regexp -- Keep the pinned parser's expression unchanged.
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
const NORMALIZE_LINE_BREAKS = /\r\n?/gmu;
// oxlint-disable-next-line prefer-named-capture-group, require-unicode-regexp -- Preserve the pinned parser's quote stripping and backreference.
const OUTER_QUOTES = /^(['"`])([\s\S]*)\1$/gm;

const parseDotenv = (source: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const lines = source.replaceAll(NORMALIZE_LINE_BREAKS, "\n");
  let match;
  while ((match = LINE.exec(lines)) !== null) {
    const [, key, rawValue] = match;
    if (key === undefined) {
      continue;
    }
    let value = (rawValue || "").trim();
    const [quote] = value;
    value = value.replaceAll(OUTER_QUOTES, "$2");
    if (quote === '"') {
      value = value.replaceAll("\\n", "\n").replaceAll("\\r", "\r");
    }
    result[key] = value;
  }
  return result;
};

const encodeValue = (key: string, value: string): string => {
  const escaped = value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
  const candidates = [`'${value}'`, `\`${value}\``, `"${escaped}"`];
  if (value && !["'", '"', "`"].includes(value[0] ?? "")) {
    candidates.push(value);
  }
  for (const [index, candidate] of candidates.entries()) {
    if (index < 3 && candidate.at(-2) === "\\") {
      continue;
    }
    const parsed = parseDotenv(`KEY=${candidate}\n`);
    if (Object.keys(parsed).length === 1 && parsed.KEY === value) {
      return candidate;
    }
  }
  throw new DotenvValueError(key);
};

export const formatDotenv = (
  entries: readonly { key: string; value: string }[]
): string => {
  const document = entries
    .map(({ key, value }) => `${key}=${encodeValue(key, value)}\n`)
    .join("");
  const parsed = parseDotenv(document);
  for (const { key, value } of entries) {
    if (parsed[key] !== value) {
      throw new DotenvValueError(key);
    }
  }
  const expectedKeys = new Set(entries.map(({ key }) => key));
  if (Object.keys(parsed).length !== expectedKeys.size && entries[0]) {
    throw new DotenvValueError(entries[0].key);
  }
  return document;
};
