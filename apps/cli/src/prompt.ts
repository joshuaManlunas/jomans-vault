import { UsageError } from "./errors";

export const readHiddenValue = async (key: string): Promise<string | null> => {
  const input = process.stdin;
  const wasRaw = input.isRaw;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const result = Promise.withResolvers<string | null>();
  let value = "";
  const onData = (chunk: Buffer) => {
    try {
      for (const character of decoder.decode(chunk, { stream: true })) {
        if (character === "\u0003") {
          result.resolve(null);
          return;
        }
        if (character === "\r" || character === "\n") {
          result.resolve(value);
          return;
        }
        if (character === "\u007F" || character === "\b") {
          value = [...value].slice(0, -1).join("");
        } else {
          value += character;
        }
      }
    } catch {
      result.reject(new UsageError("The value is not valid UTF-8 text."));
    }
  };
  const onEnd = () => result.resolve(value);
  const onError = () => result.reject(new Error("Could not read the value."));
  const onInterrupt = () => result.resolve(null);
  try {
    input.setRawMode(true);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
    process.stderr.write(`Value for ${key}: `);
    input.resume();
    return await result.promise;
  } finally {
    input.pause();
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onError);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    input.setRawMode(wasRaw ?? false);
    process.stderr.write("\n");
  }
};
