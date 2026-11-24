CREATE TABLE "login_request" (
	"id" text PRIMARY KEY,
	"machine_name" text NOT NULL,
	"project" text,
	"environment" text,
	"polling_secret_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"api_key_id" text,
	"key_ciphertext" bytea,
	"key_iv" bytea,
	"wrapped_dek" bytea,
	"dek_iv" bytea,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
