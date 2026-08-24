CREATE TYPE "public"."commerce_order_state" AS ENUM('placed', 'active', 'cancelled', 'withdrawn', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."legal_acceptance_context" AS ENUM('signup', 'paid_conversion', 'reacceptance');--> statement-breakpoint
CREATE TYPE "public"."payer_capacity" AS ENUM('consumer', 'organization');--> statement-breakpoint
CREATE TYPE "public"."performance_start" AS ENUM('deferred', 'immediate');--> statement-breakpoint
CREATE TABLE "commerce_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"placed_by_user_id" uuid NOT NULL,
	"state" "commerce_order_state" DEFAULT 'placed' NOT NULL,
	"capacity" "payer_capacity" NOT NULL,
	"authority_attestation" text,
	"billing_country" text NOT NULL,
	"billing_address" jsonb NOT NULL,
	"tax_id" text,
	"total_minor_units" integer NOT NULL,
	"currency" text NOT NULL,
	"product_id" text NOT NULL,
	"period_days" integer NOT NULL,
	"renews_automatically" boolean NOT NULL,
	"cancellation_notice_days" integer NOT NULL,
	"document_versions" jsonb NOT NULL,
	"performance_start" "performance_start",
	"proportional_charge_acknowledged_at" timestamp with time zone,
	"withdrawal_period_ends_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawal_retained_minor_units" integer,
	"withdrawal_refund_minor_units" integer,
	"cancelled_at" timestamp with time zone,
	"access_ends_at" timestamp with time zone,
	"stripe_subscription_id" text,
	"stripe_payment_intent_id" text,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_acceptance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"document_id" text NOT NULL,
	"document_version" text NOT NULL,
	"document_hash" text NOT NULL,
	"locale" text NOT NULL,
	"context" "legal_acceptance_context" NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "payer_capacity" "payer_capacity";--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "billing_country" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "authority_attestation" text;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_placed_by_user_id_user_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptance" ADD CONSTRAINT "legal_acceptance_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptance" ADD CONSTRAINT "legal_acceptance_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_order_org_idx" ON "commerce_order" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "commerce_order_state_idx" ON "commerce_order" USING btree ("state");--> statement-breakpoint
CREATE INDEX "commerce_order_subscription_idx" ON "commerce_order" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "legal_acceptance_user_document_idx" ON "legal_acceptance" USING btree ("user_id","document_id","document_version");--> statement-breakpoint
CREATE INDEX "legal_acceptance_org_idx" ON "legal_acceptance" USING btree ("organization_id");