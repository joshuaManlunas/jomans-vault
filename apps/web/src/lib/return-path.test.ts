import { expect, test } from "bun:test";

import { safeReturnPath } from "./return-path";

test("return paths keep in-app query strings and hashes and reject redirects", () => {
  const cases: [unknown, string][] = [
    ["/cli/authorize?request=abc", "/cli/authorize?request=abc"],
    ["/projects/app/dev#x", "/projects/app/dev#x"],
    [undefined, "/projects"],
    ["", "/projects"],
    [42, "/projects"],
    ["projects", "/projects"],
    ["https://example.com", "/projects"],
    ["//example.com", "/projects"],
    ["/\\example.com", "/projects"],
    ["/\t/example.com", "/projects"],
    // oxlint-disable-next-line no-script-url -- Untrusted redirect input must be rejected.
    ["javascript:alert(1)", "/projects"],
    [" /projects", "/projects"],
    ["/projects/..//example.com", "/projects"],
    [
      "/projects/../cli/authorize?request=abc#result",
      "/cli/authorize?request=abc#result",
    ],
  ];
  for (const [value, expected] of cases) {
    expect(safeReturnPath(value)).toBe(expected);
  }
});
