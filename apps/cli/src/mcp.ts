import { constants } from "node:os";

import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

import { findLink, resolveVaultUrl } from "./config";
import type { CredentialStore } from "./credentials";
import { fetchValues } from "./run";
import { listSecrets, storeSecret } from "./secrets";

const outputCap = 1_048_576;
const defaultTimeoutSeconds = 120;
const maximumTimeoutSeconds = 600;

const capture = async (
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
) => {
  const kept = new Uint8Array(outputCap);
  let length = 0;
  let truncated = false;
  try {
    await stream.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          const count = Math.min(chunk.length, outputCap - length);
          kept.set(chunk.subarray(0, count), length);
          length += count;
          truncated ||= count < chunk.length;
        },
      }),
      { signal }
    );
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  }
  return {
    text: new TextDecoder().decode(kept.subarray(0, length)),
    truncated,
  };
};

const result = (output: Record<string, unknown>): CallToolResult => ({
  structuredContent: output,
  content: [{ type: "text", text: JSON.stringify(output) }],
});
const toolCall = async (
  action: () => Promise<CallToolResult>
): Promise<CallToolResult> => {
  try {
    return await action();
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : "Command failed.",
        },
      ],
    };
  }
};

export const mcp = async ({
  flags,
  env,
  credentials,
}: {
  flags: { project?: string; env?: string; url?: string };
  env: NodeJS.ProcessEnv;
  credentials: CredentialStore;
}): Promise<number> => {
  if (flags.url !== undefined) {
    await resolveVaultUrl({ flag: flags.url, env });
  }
  const children = new Set<Bun.Subprocess<"ignore", "pipe", "pipe">>();
  let stopping = false;
  const target = async () => {
    const link = await findLink(process.cwd());
    const project = flags.project ?? link?.project;
    const environment = flags.env ?? link?.env;
    if (environment && !project) {
      throw new Error("An environment requires a project. Pass --project <p>.");
    }
    if (!project || !environment) {
      throw new Error(
        "No project and environment. Run jv link <project> --env <env>, or pass --project and --env."
      );
    }
    const url = await resolveVaultUrl({
      flag: flags.url,
      env,
      linked: link?.url,
    });
    return { url, project, environment, credentials };
  };
  const execute = async (command: string[], timeoutSeconds: number) => {
    const resolved = await target();
    const key = await credentials.get(resolved.url);
    if (!key) {
      throw new Error(`Not logged in to ${resolved.url}. Run jv login.`);
    }
    const values = await fetchValues(
      resolved.url,
      resolved.project,
      resolved.environment,
      key
    );
    if (stopping) {
      throw new Error("Command failed.");
    }
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(command, {
        env: { ...env, ...values },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      throw new Error(`Could not start ${command[0]}.`);
    }
    children.add(child);
    const output = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      output.abort();
    }, timeoutSeconds * 1000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        capture(child.stdout, output.signal),
        capture(child.stderr, output.signal),
      ]);
      const signal = child.signalCode;
      const exitCode = signal
        ? 128 +
          (typeof signal === "number" ? signal : constants.signals[signal])
        : code;
      return result({
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
      });
    } finally {
      clearTimeout(timer);
      children.delete(child);
    }
  };
  const handle = serveStdio(() => {
    const server = new McpServer(
      { name: "jv", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
    server.registerTool(
      "run",
      {
        description:
          "Run a trusted command with vault values in its environment. Commands can print or send those values; this is plaintext access.",
        inputSchema: z.object({
          command: z.array(z.string()).min(1),
          timeoutSeconds: z
            .number()
            .int()
            .min(1)
            .max(maximumTimeoutSeconds)
            .optional(),
        }),
        outputSchema: z.object({
          exitCode: z.number().int(),
          stdout: z.string(),
          stderr: z.string(),
          stdoutTruncated: z.boolean(),
          stderrTruncated: z.boolean(),
          timedOut: z.boolean(),
        }),
      },
      async ({ command, timeoutSeconds }) =>
        await toolCall(
          async () =>
            await execute(command, timeoutSeconds ?? defaultTimeoutSeconds)
        )
    );
    server.registerTool(
      "list",
      {
        description: "List secret metadata without values (requires read).",
        inputSchema: z.object({}),
        outputSchema: z.object({
          secrets: z.array(
            z.object({
              key: z.string(),
              kind: z.enum(["secret", "env", "token"]),
              version: z.number().int(),
              updatedAt: z.string(),
            })
          ),
        }),
      },
      async () =>
        await toolCall(async () =>
          result({ secrets: await listSecrets(await target()) })
        )
    );
    server.registerTool(
      "set",
      {
        description:
          "Store a secret without echoing its value (requires write).",
        inputSchema: z.object({ key: z.string(), value: z.string() }),
        outputSchema: z.object({ key: z.string(), version: z.number().int() }),
      },
      async ({ key, value }) =>
        await toolCall(async () => {
          const row = await storeSecret({ ...(await target()), key, value });
          return result({ key: row.key, version: row.version });
        })
    );
    return server;
  });
  const ended = Promise.withResolvers<number>();
  const shutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const child of children) {
      child.kill("SIGKILL");
    }
    void (async () => {
      await Promise.all([...children].map((child) => child.exited));
      await handle.close();
      ended.resolve(0);
    })();
  };
  process.stdin.once("end", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    return await ended.promise;
  } finally {
    process.stdin.off("end", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
};
