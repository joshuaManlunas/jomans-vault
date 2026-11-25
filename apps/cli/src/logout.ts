import type { CredentialStore } from "./credentials";

export const logout = async ({
  url,
  credentials,
}: {
  url: string | null;
  credentials: CredentialStore;
}): Promise<number> => {
  if (url === null) {
    console.error("Not logged in. Nothing to log out of.");
    return 0;
  }
  const key = await credentials.get(url);
  if (key === null) {
    console.error(`Not logged in to ${url}. Nothing to log out of.`);
    return 0;
  }
  let status: number | null = null;
  try {
    const response = await fetch(`${url}/api/v1/api-keys/current/revoke`, {
      method: "POST",
      redirect: "manual",
      headers: { "x-api-key": key },
      signal: AbortSignal.timeout(10_000),
    });
    ({ status } = response);
  } catch {
    // Local credentials must be removed even when the vault is unreachable.
  }
  const warning =
    status === null
      ? `warning: could not reach the vault at ${url}.`
      : `warning: the vault at ${url} returned an unexpected response (${status}).`;
  const revokeManually = "Revoke it on the API keys settings page.";
  try {
    await credentials.delete(url);
  } catch (error) {
    if (status === 200) {
      console.error("The key was revoked.");
    } else if (status === 401) {
      console.error("The key was already invalid.");
    } else {
      console.error(`${warning} The key was NOT revoked. ${revokeManually}`);
    }
    console.error(
      `Could not remove the key from this machine: ${error instanceof Error ? error.message : "Unknown storage error."}`
    );
    return 1;
  }
  if (status === 200) {
    console.error(
      `Logged out of ${url}. The key was revoked and removed from this machine.`
    );
    return 0;
  }
  if (status === 401) {
    console.error(
      `Logged out of ${url}. The key was already invalid and was removed from this machine.`
    );
    return 0;
  }
  console.error(
    `${warning} The key was removed from this machine but was NOT revoked. ${revokeManually}`
  );
  return 1;
};
