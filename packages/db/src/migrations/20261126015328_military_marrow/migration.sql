ALTER TABLE "login_request" ADD COLUMN "pairing_code_hash" text;--> statement-breakpoint
ALTER TABLE "login_request" ADD COLUMN "failed_pairing_attempts" integer DEFAULT 0 NOT NULL;