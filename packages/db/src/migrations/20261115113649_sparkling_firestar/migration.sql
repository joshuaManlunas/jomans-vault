CREATE TABLE "audit_event" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"environment_id" text,
	"secret_id" text,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_key" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"wrapped_dek" bytea NOT NULL,
	"iv" bytea NOT NULL,
	"kek_version" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "audit_event_project_id_idx" ON "audit_event" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_owner_id_slug_unique" ON "project" ("owner_id","slug");--> statement-breakpoint
CREATE INDEX "project_key_project_id_idx" ON "project_key" ("project_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_owner_id_user_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_key" ADD CONSTRAINT "project_key_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;