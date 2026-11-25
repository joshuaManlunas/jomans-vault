import { hostname } from "node:os";

import * as z from "zod";

import { writeRememberedUrl } from "./config";
import type { CredentialStore } from "./credentials";

const openedSchema = z.object({
  id: z.string().min(1),
  pollingSecret: z.string().min(1),
  expiresAt: z.iso.datetime(),
});
const pollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("approved"), key: z.string().min(1) }),
]);

const post = async <T>(
  url: string,
  path: string,
  body: unknown,
  schema: z.ZodType<T>
): Promise<T> => {
  let response: Response;
  let responseBody = "";
  try {
    response = await fetch(`${url}/api/v1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      responseBody = await response.text();
    }
  } catch {
    throw new Error(`Could not reach the vault at ${url}.`);
  }
  try {
    if (response.ok) {
      return schema.parse(JSON.parse(responseBody));
    }
  } catch {
    // Invalid JSON and invalid response shapes are unexpected responses.
  }
  throw new Error(
    `The vault at ${url} returned an unexpected response (${response.status}).`
  );
};

const openBrowser = (link: string) => {
  const opener = Bun.which(process.platform === "darwin" ? "open" : "xdg-open");
  if (opener) {
    try {
      Bun.spawn([opener, link], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).unref();
    } catch {
      // The printed link also works when the platform opener cannot start.
    }
  }
};

const pollUntilAnswered = async (
  url: string,
  id: string,
  pollingSecret: string
) => {
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- Each poll follows the previous pending response by one second.
    await Bun.sleep(1000);
    // oxlint-disable-next-line no-await-in-loop -- The next request depends on this poll's status.
    const result = await post(
      url,
      `/login-requests/${encodeURIComponent(id)}/poll`,
      { pollingSecret },
      pollSchema
    );
    if (result.status !== "pending") {
      return result;
    }
  }
};

export const login = async ({
  url,
  noBrowser,
  env,
  credentials,
  project,
  environment,
}: {
  url: string;
  noBrowser: boolean;
  env: NodeJS.ProcessEnv;
  credentials: CredentialStore;
  project?: string;
  environment?: string;
}): Promise<number> => {
  const opened = await post(
    url,
    "/login-requests",
    {
      machineName: hostname().trim().slice(0, 32) || "jv",
      ...(project === undefined ? {} : { project }),
      ...(environment === undefined ? {} : { env: environment }),
    },
    openedSchema
  );
  const link = `${url}/cli/authorize?request=${encodeURIComponent(opened.id)}`;
  console.error(`Open this link to approve this machine: ${link}`);
  if (!noBrowser) {
    openBrowser(link);
  }
  const result = await pollUntilAnswered(url, opened.id, opened.pollingSecret);
  if (result.status === "denied") {
    console.error("The login request was denied. Nothing was stored.");
    return 1;
  }
  if (result.status === "expired") {
    console.error(
      "The login request expired before it was approved. Run jv login again."
    );
    return 1;
  }
  let location;
  try {
    location = await credentials.set(url, result.key);
  } catch (error) {
    throw new Error(
      `Could not finish storing the vault credential: ${error instanceof Error ? error.message : "Unknown storage error."}`,
      { cause: error }
    );
  }
  if (location.kind === "file") {
    console.error(
      `warning: the OS keychain is unavailable; the key was stored in ${location.path} (readable only by you).`
    );
  }
  const destination =
    location.kind === "keychain" ? "the OS keychain" : location.path;
  try {
    await writeRememberedUrl(env, url);
  } catch (error) {
    throw new Error(
      `Key stored in ${destination}, but could not remember the vault URL: ${error instanceof Error ? error.message : "Unknown storage error."}`,
      { cause: error }
    );
  }
  console.error(`Logged in to ${url}. Key stored in ${destination}.`);
  return 0;
};
