ALTER TABLE "login_request" ADD COLUMN "client_ip" text;--> statement-breakpoint
CREATE INDEX "login_request_created_at_idx" ON "login_request" ("created_at");