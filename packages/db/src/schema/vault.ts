import {
  bytea,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

export const project = pgTable(
  "project",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("project_owner_id_slug_unique").on(table.ownerId, table.slug),
  ]
);

export const environment = pgTable(
  "environment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("environment_project_id_slug_unique").on(
      table.projectId,
      table.slug
    ),
  ]
);

export const projectKey = pgTable(
  "project_key",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    wrappedDek: bytea("wrapped_dek").notNull(),
    iv: bytea("iv").notNull(),
    kekVersion: integer("kek_version").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    retiredAt: timestamp("retired_at"),
  },
  (table) => [index("project_key_project_id_idx").on(table.projectId)]
);

export const auditEvent = pgTable(
  "audit_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id"),
    secretId: text("secret_id"),
    action: text("action").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("audit_event_project_id_idx").on(table.projectId)]
);
