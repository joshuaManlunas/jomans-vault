import { expect, test } from "bun:test";

import { parse } from "dotenv";

import { DotenvValueError, formatDotenv } from "./dotenv";

test.each([
  { value: "has space", encoded: "'has space'" },
  { value: "p a$ss=\\", encoded: "p a$ss=\\" },
  { value: "it's", encoded: "'it's'" },
  { value: 'say "hi"', encoded: "'say \"hi\"'" },
  { value: "tick`s", encoded: "'tick`s'" },
  { value: "a#b", encoded: "'a#b'" },
  { value: "k=v", encoded: "'k=v'" },
  { value: "$HOME", encoded: "'$HOME'" },
  { value: "back\\slash", encoded: "'back\\slash'" },
  { value: "C:\\dir\\", encoded: "C:\\dir\\" },
  { value: "two\nlines", encoded: "'two\nlines'" },
  { value: "a\r\nb", encoded: '"a\\r\\nb"' },
  { value: "a\rb", encoded: '"a\\rb"' },
  { value: "a'b\"c`\nd", encoded: '"a\'b"c`\\nd"' },
  { value: "", encoded: "''" },
])("accepts and round-trips $value", ({ value, encoded }) => {
  const document = formatDotenv([{ key: "K", value }]);
  expect(document).toBe(`K=${encoded}\n`);
  expect(parse(document)).toEqual({ K: value });
});

test.each(["a'b\"c`#", "\r\\n", "p a$ss=#\\"])(
  "refuses an unwritable value without including it in the error",
  (value) => {
    try {
      formatDotenv([{ key: "K", value }]);
      throw new Error("Expected the writer to refuse this value");
    } catch (error) {
      expect(error).toBeInstanceOf(DotenvValueError);
      if (error instanceof DotenvValueError) {
        expect(error.key).toBe("K");
        expect(error.message).toBe(
          "Secret K cannot be exported as dotenv; use format=json"
        );
        expect(error.message).not.toContain(value);
      }
    }
  }
);

test("preserves entry order, refuses the first unwritable key and writes empty input", () => {
  expect(formatDotenv([])).toBe("");
  expect(
    formatDotenv([
      { key: "Z", value: "last" },
      { key: "A", value: "first" },
    ])
  ).toBe("Z='last'\nA='first'\n");
  try {
    formatDotenv([
      { key: "FIRST", value: "\r\\n" },
      { key: "SECOND", value: "\r\\n" },
    ]);
    throw new Error("Expected the writer to refuse the first value");
  } catch (error) {
    expect(error).toBeInstanceOf(DotenvValueError);
    if (error instanceof DotenvValueError) {
      expect(error.key).toBe("FIRST");
    }
  }
});

test.each(["\n", "\r", "\r\n", "\n \t", "\u2028", "\u2029"])(
  "exports long blank-line values without repeatedly scanning them (%j)",
  (lineBreak) => {
    const repetitions = Math.floor(65_000 / Buffer.byteLength(lineBreak));
    const value = `'#\n${lineBreak.repeat(repetitions)}#`;
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(65_536);
    const start = performance.now();
    const document = formatDotenv([
      { key: "K", value },
      { key: "NEXT", value: "after" },
    ]);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(parse(document)).toEqual({ K: value, NEXT: "after" });
  }
);

const shortValues = (maxLength: number): string[] => {
  const alphabet = [
    "a",
    " ",
    "'",
    '"',
    "`",
    "#",
    "\\",
    "n",
    "\n",
    "\r",
    "=",
    "$",
  ];
  const values = [""];
  let layer = [""];
  for (let length = 1; length <= maxLength; length += 1) {
    layer = layer.flatMap((prefix) => alphabet.map((char) => prefix + char));
    values.push(...layer);
  }
  return values;
};

test("every adversarial value through length four round-trips or fails without disclosure", () => {
  const values = shortValues(4);
  expect(values).toHaveLength(22_621);
  for (const value of values) {
    let document;
    try {
      document = formatDotenv([{ key: "K", value }]);
    } catch (error) {
      expect(error).toBeInstanceOf(DotenvValueError);
      if (error instanceof DotenvValueError) {
        expect(error.key).toBe("K");
        expect(error.message).not.toContain(value);
      }
      continue;
    }
    expect(parse(document)).toEqual({ K: value });
  }
});

test("every pair of accepted adversarial values through length two round-trips together", () => {
  const accepted = shortValues(2).filter((value) => {
    try {
      formatDotenv([{ key: "K", value }]);
      return true;
    } catch (error) {
      expect(error).toBeInstanceOf(DotenvValueError);
      return false;
    }
  });
  for (const first of accepted) {
    for (const second of accepted) {
      const document = formatDotenv([
        { key: "FIRST", value: first },
        { key: "SECOND", value: second },
      ]);
      expect(parse(document)).toEqual({ FIRST: first, SECOND: second });
    }
  }
}, 30_000);
