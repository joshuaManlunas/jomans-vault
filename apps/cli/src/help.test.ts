import { expect, test } from "bun:test";

import { createSandbox, runJv } from "./test/harness";

const commandPattern = /^ {2}(?<command>[a-z]+)\s+/gmu;
const flagPattern = /^ {2}(?<flag>--[a-z-]+)/gmu;
const codeBlockPattern = /^```[^\n]*\n(?<code>[\s\S]*?)^```/gmu;

test("the CLI reference covers every help command and flag", async () => {
  const sandbox = await createSandbox();
  try {
    const result = await runJv(["help"], { env: sandbox.env });
    expect(result.exitCode).toBe(0);
    const commandsBlock = result.stdout
      .split("Commands:\n")[1]
      ?.split("\n\n")[0];
    const [, flagsBlock] = result.stdout.split("Flags:\n");
    expect(commandsBlock).toBeDefined();
    expect(flagsBlock).toBeDefined();
    const commands = [...(commandsBlock ?? "").matchAll(commandPattern)].map(
      (match) => match.groups?.command ?? ""
    );
    const flags = [...(flagsBlock ?? "").matchAll(flagPattern)].map(
      (match) => match.groups?.flag ?? ""
    );
    expect(commands.length).toBeGreaterThan(0);
    expect(flags.length).toBeGreaterThan(0);
    const reference = await Bun.file(
      new URL("../../fumadocs/content/docs/cli.mdx", import.meta.url)
    ).text();
    const code = [...reference.matchAll(codeBlockPattern)]
      .map((match) => match.groups?.code ?? "")
      .join("\n");
    for (const command of [...commands, "help"]) {
      const documented =
        new RegExp(`^#{1,6} (?:jv )?${command}(?:\\s|$)`, "mu").test(
          reference
        ) || new RegExp(`\\bjv ${command}(?:\\s|$)`, "mu").test(code);
      expect(documented, `Missing CLI command: ${command}`).toBe(true);
    }
    for (const flag of flags) {
      expect(reference, `Missing CLI flag: ${flag}`).toContain(`\`${flag}\``);
    }
  } finally {
    await sandbox.remove();
  }
});
