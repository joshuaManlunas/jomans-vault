export const auditPageSize = 50;

export interface AuditEventFields {
  actorType: string;
  actorId: string;
  projectId: string | null;
  projectSlug: string | null;
  environmentId: string | null;
  environmentSlug: string | null;
  secretId: string | null;
  secretKey: string | null;
  apiKeyId: string | null;
}

export interface AuditKey {
  id: string;
  name: string | null;
  revoked: boolean;
}

export interface AuditFilters {
  project: string | null;
  actor: string | null;
}

export const auditListInput = (
  filters: AuditFilters,
  cursor: string | undefined
): { limit: number; project?: string; actor?: string; cursor?: string } => ({
  limit: auditPageSize,
  ...(filters.project === null ? {} : { project: filters.project }),
  ...(filters.actor === null ? {} : { actor: filters.actor }),
  ...(cursor === undefined ? {} : { cursor }),
});

export const keyLabel = (key: { name: string | null }): string =>
  key.name ?? "Unnamed key";

export const keyNames = (
  keys: readonly AuditKey[]
): ReadonlyMap<string, string> =>
  new Map(keys.map((key) => [key.id, keyLabel(key)]));

export const actorLabel = (
  event: AuditEventFields,
  userId: string,
  names: ReadonlyMap<string, string>
): string => {
  if (event.actorType === "user") {
    return event.actorId === userId ? "You" : `User ${event.actorId}`;
  }
  if (event.actorType === "apiKey") {
    return names.get(event.actorId) ?? `Deleted key (${event.actorId})`;
  }
  return `${event.actorType} ${event.actorId}`;
};

export const targetLabel = (
  event: AuditEventFields,
  names: ReadonlyMap<string, string>
): string => {
  if (event.secretId !== null) {
    return event.secretKey ?? "Deleted secret";
  }
  if (event.apiKeyId !== null) {
    return names.get(event.apiKeyId) ?? `Deleted key (${event.apiKeyId})`;
  }
  return "None";
};

export const projectLabel = (event: AuditEventFields): string => {
  if (event.projectId === null) {
    return "None";
  }
  return event.projectSlug ?? "Deleted project";
};

export const environmentLabel = (event: AuditEventFields): string => {
  if (event.environmentId === null) {
    return "None";
  }
  return event.environmentSlug ?? "Deleted environment";
};

export const recordedLabel = (value: string | null): string =>
  value === null || value === "" ? "Not recorded" : value;

export const actorFilterOptions = (
  keys: readonly AuditKey[]
): { value: string; label: string }[] => [
  { value: "user", label: "You" },
  ...keys.map((key) => ({
    value: key.id,
    label: `${keyLabel(key)}${key.revoked ? " (revoked)" : ""}`,
  })),
];
