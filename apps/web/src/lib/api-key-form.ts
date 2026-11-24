export const expiryPresets = [
  { value: "never", label: "Never", seconds: undefined },
  { value: "7d", label: "7 days", seconds: 604_800 },
  { value: "30d", label: "30 days", seconds: 2_592_000 },
  { value: "90d", label: "90 days", seconds: 7_776_000 },
  { value: "1y", label: "1 year", seconds: 31_536_000 },
] as const;

export type ApiKeyStatus = "active" | "revoked" | "expired";

export const apiKeyStatus = (
  key: { revoked: boolean; expiresAt: string | null },
  now: Date
): ApiKeyStatus => {
  if (key.revoked) {
    return "revoked";
  }
  if (key.expiresAt !== null && new Date(key.expiresAt) <= now) {
    return "expired";
  }
  return "active";
};

export const buildScope = (
  selected: Record<string, readonly string[]>
): { projects: Record<string, string[]> } => ({
  projects: Object.fromEntries(
    Object.entries(selected)
      .filter(([, environments]) => environments.length > 0)
      .map(([project, environments]) => [project, [...environments]])
  ),
});
