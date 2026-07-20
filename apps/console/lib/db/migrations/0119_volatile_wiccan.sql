CREATE TYPE "public"."signing_backend" AS ENUM('kms', 'secret');--> statement-breakpoint
CREATE TYPE "public"."signing_key_status" AS ENUM('pending_verification', 'active', 'invalid');--> statement-breakpoint
CREATE TABLE "org_signing_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"provider" "cloud_provider" NOT NULL,
	"backend" "signing_backend" NOT NULL,
	"key_ref" text NOT NULL,
	"public_key" text NOT NULL,
	"key_id" text NOT NULL,
	"algorithm" text DEFAULT 'ed25519' NOT NULL,
	"status" "signing_key_status" DEFAULT 'pending_verification' NOT NULL,
	"status_message" text,
	"active" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_signing_key_key_id_key" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "org_signing_key_one_active" ON "org_signing_key" USING btree ("org_id") WHERE "org_signing_key"."active" = true;--> statement-breakpoint
CREATE INDEX "idx_org_signing_key_org" ON "org_signing_key" USING btree ("org_id");