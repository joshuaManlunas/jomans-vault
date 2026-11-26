const whitespacePattern = /\s+/u;

export const getUserInitials = (
  name: string | null | undefined,
  email: string | null | undefined
): string => {
  const words = (name ?? "")
    .trim()
    .split(whitespacePattern)
    .filter((word) => word.length > 0);

  if (words.length >= 2) {
    const first = [...(words[0] ?? "")][0] ?? "";
    const last = [...(words.at(-1) ?? "")][0] ?? "";
    return `${first}${last}`.toUpperCase();
  }

  if (words.length === 1) {
    return ([...(words[0] ?? "")][0] ?? "").toUpperCase();
  }

  const fallback = [...(email ?? "").trim()][0] ?? "?";
  return fallback.toUpperCase();
};
