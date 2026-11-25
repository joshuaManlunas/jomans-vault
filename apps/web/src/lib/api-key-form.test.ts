import { expect, test } from "bun:test";

import {
  apiKeyStatus,
  buildScope,
  expiryPresets,
  suggestedSelection,
} from "./api-key-form";

test("expiry presets use seconds within the API range", () => {
  const expected = [
    ["never", undefined],
    ["7d", 604_800],
    ["30d", 2_592_000],
    ["90d", 7_776_000],
    ["1y", 31_536_000],
  ] as const;
  expect(expiryPresets).toHaveLength(expected.length);
  for (const [value, seconds] of expected) {
    const preset = expiryPresets.find((option) => option.value === value);
    expect(preset?.seconds).toBe(seconds);
    if (preset?.seconds !== undefined) {
      expect(preset.seconds).toBeGreaterThanOrEqual(86_400);
      expect(preset.seconds).toBeLessThanOrEqual(31_536_000);
    }
  }
});

test("scope keeps selected environments in order and drops empty projects", () => {
  const cases: {
    selected: Record<string, string[]>;
    projects: Record<string, string[]>;
  }[] = [
    { selected: {}, projects: {} },
    { selected: { empty: [] }, projects: {} },
    {
      selected: {
        empty: [],
        app: ["staging", "development"],
        site: ["production"],
      },
      projects: {
        app: ["staging", "development"],
        site: ["production"],
      },
    },
  ];
  for (const { selected, projects } of cases) {
    expect(buildScope(selected)).toEqual({ projects });
  }
});

test("status gives revocation precedence and expires at the boundary", () => {
  const now = new Date("2026-11-25T12:00:00Z");
  const cases = [
    { revoked: true, expiresAt: "2026-11-24T12:00:00Z", status: "revoked" },
    { revoked: true, expiresAt: null, status: "revoked" },
    { revoked: false, expiresAt: "2026-11-24T12:00:00Z", status: "expired" },
    { revoked: false, expiresAt: now.toISOString(), status: "expired" },
    { revoked: false, expiresAt: "2026-11-26T12:00:00Z", status: "active" },
    { revoked: false, expiresAt: null, status: "active" },
  ] as const;
  for (const { revoked, expiresAt, status } of cases) {
    expect(apiKeyStatus({ revoked, expiresAt }, now)).toBe(status);
  }
});

test("suggested selection only ticks an owned environment", () => {
  const cases: {
    suggestion: { project: string | null; env: string | null };
    expected: Record<string, string[]>;
  }[] = [
    {
      suggestion: { project: "app", env: "development" },
      expected: { app: ["development"] },
    },
    { suggestion: { project: "app", env: "production" }, expected: {} },
    { suggestion: { project: "other", env: "development" }, expected: {} },
    { suggestion: { project: "app", env: null }, expected: {} },
    { suggestion: { project: null, env: null }, expected: {} },
  ];
  for (const { suggestion, expected } of cases) {
    expect(suggestedSelection(suggestion, { app: ["development"] })).toEqual(
      expected
    );
  }
});
