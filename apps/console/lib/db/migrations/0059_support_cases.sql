CREATE TYPE "public"."support_case_type" AS ENUM('technical', 'billing', 'account', 'general', 'abuse');--> statement-breakpoint
CREATE TYPE "public"."support_case_category" AS ENUM('clusters', 'jobs', 'runners', 'connectors', 'networking', 'billing_invoices', 'account_access', 'quotas_limits', 'api_cli', 'agent_ai', 'other');--> statement-breakpoint
CREATE TYPE "public"."support_case_severity" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."support_case_status" AS ENUM('open', 'pending_support', 'pending_customer', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."support_author_type" AS ENUM('customer', 'staff', 'system', 'ai');--> statement-breakpoint
CREATE TYPE "public"."support_abuse_category" AS ENUM('phishing', 'malware', 'spam', 'copyright', 'csam', 'other');--> statement-breakpoint
CREATE TABLE "support_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_number" bigserial NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"type" "support_case_type" NOT NULL,
	"category" "support_case_category" NOT NULL,
	"severity" "support_case_severity" DEFAULT 'normal' NOT NULL,
	"status" "support_case_status" DEFAULT 'open' NOT NULL,
	"subject" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"contact" jsonb NOT NULL,
	"abuse" jsonb,
	"assigned_staff_id" uuid,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_author_type" "support_author_type" DEFAULT 'customer' NOT NULL,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"author_type" "support_author_type" NOT NULL,
	"author_id" uuid,
	"author_name" text,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "support_case_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"message_id" uuid,
	"uploaded_by" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "support_case_reads" (
	"case_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_case_reads_case_id_user_id_pk" PRIMARY KEY("case_id","user_id")
);--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_attachments" ADD CONSTRAINT "support_case_attachments_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_attachments" ADD CONSTRAINT "support_case_attachments_message_id_support_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."support_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case_reads" ADD CONSTRAINT "support_case_reads_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_support_cases_user" ON "support_cases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_support_cases_org" ON "support_cases" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_support_cases_status" ON "support_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_support_cases_last_msg" ON "support_cases" USING btree ("last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_support_cases_number" ON "support_cases" USING btree ("case_number");--> statement-breakpoint
CREATE INDEX "idx_support_messages_case" ON "support_messages" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_support_attachments_case" ON "support_case_attachments" USING btree ("case_id");
