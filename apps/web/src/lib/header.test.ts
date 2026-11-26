import { describe, expect, it } from "bun:test";

import { getUserInitials } from "./header";

describe("getUserInitials", () => {
  const cases = [
    {
      label: "first and last name",
      name: "Joshua Manlunas",
      email: "josh@example.com",
      expected: "JM",
    },
    {
      label: "multi-word name uses first and last",
      name: "Ada Augusta Byron",
      email: "ada@example.com",
      expected: "AB",
    },
    {
      label: "single-word name",
      name: "joman",
      email: "joman@example.com",
      expected: "J",
    },
    {
      label: "extra whitespace around name",
      name: "  grace   hopper  ",
      email: "grace@example.com",
      expected: "GH",
    },
    {
      label: "blank name falls back to email",
      name: "   ",
      email: "ops@vault.local",
      expected: "O",
    },
    {
      label: "missing name and email falls back to ?",
      name: null,
      email: "",
      expected: "?",
    },
  ] as const;

  for (const { label, name, email, expected } of cases) {
    it(`returns ${expected} for ${label}`, () => {
      expect(getUserInitials(name, email)).toBe(expected);
    });
  }
});
