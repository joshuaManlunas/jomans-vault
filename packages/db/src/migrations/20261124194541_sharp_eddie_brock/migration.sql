ALTER TABLE "audit_event" ADD COLUMN "api_key_id" text;--> statement-breakpoint
ALTER TABLE "audit_event" ALTER COLUMN "project_id" DROP NOT NULL;