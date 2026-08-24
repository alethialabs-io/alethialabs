CREATE TYPE "public"."privacy_case_event_kind" AS ENUM('received', 'identity_verified', 'identity_rejected', 'review_started', 'legal_hold_applied', 'legal_hold_cleared', 'export_generated', 'export_downloaded', 'erasure_performed', 'pseudonymized', 'vendor_notified', 'fulfilled', 'refused', 'withdrawn', 'note');--> statement-breakpoint
CREATE TYPE "public"."privacy_case_kind" AS ENUM('access', 'export', 'rectification', 'erasure', 'restriction', 'objection', 'portability');--> statement-breakpoint
CREATE TYPE "public"."privacy_case_state" AS ENUM('received', 'identity_pending', 'in_review', 'fulfilled', 'refused', 'withdrawn');--> statement-breakpoint
CREATE TABLE "privacy_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"kind" "privacy_case_kind" NOT NULL,
	"state" "privacy_case_state" DEFAULT 'received' NOT NULL,
	"subject_user_id" uuid,
	"subject_email_sha256" text NOT NULL,
	"organization_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"extended_at" timestamp with time zone,
	"extension_reason" text,
	"identity_verified_at" timestamp with time zone,
	"legal_hold_reason" text,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"refusal_reason" text,
	"scope" jsonb,
	"export_object_key" text,
	"export_manifest" jsonb,
	"export_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_case_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "privacy_case_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" "privacy_case_event_kind" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_erasure_tombstone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_email_sha256" text NOT NULL,
	"erased_user_id" uuid,
	"case_reference" text NOT NULL,
	"erased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scope" jsonb NOT NULL,
	"replayed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "privacy_case" ADD CONSTRAINT "privacy_case_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_case" ADD CONSTRAINT "privacy_case_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_case" ADD CONSTRAINT "privacy_case_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_case_event" ADD CONSTRAINT "privacy_case_event_case_id_privacy_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."privacy_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_case_event" ADD CONSTRAINT "privacy_case_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_case_subject_idx" ON "privacy_case" USING btree ("subject_email_sha256");--> statement-breakpoint
CREATE INDEX "privacy_case_state_idx" ON "privacy_case" USING btree ("state");--> statement-breakpoint
CREATE INDEX "privacy_case_due_idx" ON "privacy_case" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "privacy_case_event_case_idx" ON "privacy_case_event" USING btree ("case_id","at");--> statement-breakpoint
CREATE INDEX "privacy_tombstone_subject_idx" ON "privacy_erasure_tombstone" USING btree ("subject_email_sha256");--> statement-breakpoint
CREATE INDEX "privacy_tombstone_replayed_idx" ON "privacy_erasure_tombstone" USING btree ("replayed_at");