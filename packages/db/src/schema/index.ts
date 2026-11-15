// Drizzle schema entry (drizzle.config.ts, relations.ts): must re-export every table, including ones `auth:generate` adds.
// oxlint-disable-next-line oxc/no-barrel-file -- schema entry point; an explicit list would silently drop generated tables
export * from "./auth";
