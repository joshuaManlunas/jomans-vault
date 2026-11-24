const base = "http://app.invalid";

export const safeReturnPath = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value[1] === "/" ||
    value[1] === "\\"
  ) {
    return "/projects";
  }
  try {
    const url = new URL(value, base);
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (url.origin === base && path[1] !== "/" && path[1] !== "\\") {
      return path;
    }
  } catch {
    return "/projects";
  }
  return "/projects";
};
