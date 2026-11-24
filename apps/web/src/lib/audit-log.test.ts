import { expect, test } from "bun:test";

import type { AuditEventFields, AuditFilters } from "./audit-log";
import {
  actorFilterOptions,
  actorLabel,
  auditListInput,
  environmentLabel,
  keyLabel,
  keyNames,
  projectLabel,
  recordedLabel,
  targetLabel,
} from "./audit-log";

const keys = [
  { id: "active", name: "Agent", revoked: false },
  { id: "unnamed", name: null, revoked: false },
  { id: "revoked", name: "Old agent", revoked: true },
];
const names = keyNames(keys);
const event: AuditEventFields = {
  actorType: "user",
  actorId: "me",
  projectId: null,
  projectSlug: null,
  environmentId: null,
  environmentSlug: null,
  secretId: null,
  secretKey: null,
  apiKeyId: null,
};

test("actors retain user and key identities, including unnamed, revoked and deleted keys", () => {
  const cases = [
    ["user", "me", "You"],
    ["user", "other", "User other"],
    ["apiKey", "active", "Agent"],
    ["apiKey", "unnamed", "Unnamed key"],
    ["apiKey", "revoked", "Old agent"],
    ["apiKey", "missing", "Deleted key (missing)"],
    ["future", "actor", "future actor"],
  ];
  for (const [actorType, actorId, expected] of cases) {
    expect(actorLabel({ ...event, actorType, actorId }, "me", names)).toBe(
      expected
    );
  }
});

test("key names preserve every key in input order", () => {
  for (const key of keys) {
    expect(names.get(key.id)).toBe(keyLabel(key));
  }
  expect([...names.entries()]).toEqual([
    ["active", "Agent"],
    ["unnamed", "Unnamed key"],
    ["revoked", "Old agent"],
  ]);
});

test("targets distinguish absent, deleted and live secrets and keys", () => {
  const cases: { fields: Partial<AuditEventFields>; expected: string }[] = [
    { fields: {}, expected: "None" },
    { fields: { secretId: "secret" }, expected: "Deleted secret" },
    { fields: { secretId: "secret", secretKey: "TOKEN" }, expected: "TOKEN" },
    { fields: { apiKeyId: "active" }, expected: "Agent" },
    { fields: { apiKeyId: "unnamed" }, expected: "Unnamed key" },
    { fields: { apiKeyId: "revoked" }, expected: "Old agent" },
    { fields: { apiKeyId: "missing" }, expected: "Deleted key (missing)" },
    {
      fields: { secretId: "secret", secretKey: "TOKEN", apiKeyId: "active" },
      expected: "TOKEN",
    },
  ];
  for (const { fields, expected } of cases) {
    expect(targetLabel({ ...event, ...fields }, names)).toBe(expected);
  }
});

test("project and environment labels distinguish absent, deleted and live records", () => {
  const cases = [
    { id: null, slug: null, project: "None", environment: "None" },
    {
      id: "id",
      slug: null,
      project: "Deleted project",
      environment: "Deleted environment",
    },
    { id: "id", slug: "live", project: "live", environment: "live" },
  ];
  for (const { id, slug, project, environment } of cases) {
    const fields = {
      ...event,
      projectId: id,
      projectSlug: slug,
      environmentId: id,
      environmentSlug: slug,
    };
    expect(projectLabel(fields)).toBe(project);
    expect(environmentLabel(fields)).toBe(environment);
  }
});

test("recorded values use a placeholder only for null or empty strings", () => {
  const cases: [string | null, string][] = [
    [null, "Not recorded"],
    ["", "Not recorded"],
    ["203.0.113.7", "203.0.113.7"],
    ["audit-test/browser", "audit-test/browser"],
    ["<script>text</script>", "<script>text</script>"],
  ];
  for (const [value, expected] of cases) {
    expect(recordedLabel(value)).toBe(expected);
  }
});

test("audit input omits unselected filters and absent cursors", () => {
  const cases: {
    filters: AuditFilters;
    cursor?: string;
    expected: ReturnType<typeof auditListInput>;
  }[] = [
    { filters: { project: null, actor: null }, expected: { limit: 50 } },
    {
      filters: { project: "app", actor: null },
      expected: { limit: 50, project: "app" },
    },
    {
      filters: { project: null, actor: "user" },
      expected: { limit: 50, actor: "user" },
    },
    {
      filters: { project: null, actor: "active" },
      expected: { limit: 50, actor: "active" },
    },
    {
      filters: { project: null, actor: null },
      cursor: "older",
      expected: { limit: 50, cursor: "older" },
    },
    {
      filters: { project: "app", actor: "active" },
      cursor: "older",
      expected: {
        limit: 50,
        project: "app",
        actor: "active",
        cursor: "older",
      },
    },
  ];
  for (const { filters, cursor, expected } of cases) {
    expect(auditListInput(filters, cursor)).toStrictEqual(expected);
    expect(Object.keys(auditListInput(filters, cursor))).toEqual(
      Object.keys(expected)
    );
  }
});

test("actor filter starts with You and includes all key ids, with revoked labels", () => {
  const cases = [
    { keys: [], expected: [{ value: "user", label: "You" }] },
    {
      keys,
      expected: [
        { value: "user", label: "You" },
        { value: "active", label: "Agent" },
        { value: "unnamed", label: "Unnamed key" },
        { value: "revoked", label: "Old agent (revoked)" },
      ],
    },
  ];
  for (const { keys: input, expected } of cases) {
    expect(actorFilterOptions(input)).toEqual(expected);
  }
});
