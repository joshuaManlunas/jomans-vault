CREATE TABLE "secret" (
	"id" text PRIMARY KEY,
	"environment_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"current_version_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_version" (
	"id" text PRIMARY KEY,
	"secret_id" text NOT NULL,
	"version" integer NOT NULL,
	"ciphertext" bytea NOT NULL,
	"iv" bytea NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "secret_environment_id_key_live_unique" ON "secret" ("environment_id","key") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "secret_version_secret_id_version_unique" ON "secret_version" ("secret_id","version");--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_environment_id_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environment"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_current_version_id_secret_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "secret_version"("id");--> statement-breakpoint
ALTER TABLE "secret_version" ADD CONSTRAINT "secret_version_secret_id_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "secret"("id") ON DELETE CASCADE;