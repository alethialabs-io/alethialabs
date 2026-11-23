CREATE TABLE "early_access_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"country" text NOT NULL,
	"vat_id" text NOT NULL,
	"plan_wanted" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"requester_note" text,
	"vies_valid" boolean,
	"vies_name" text,
	"vies_address" text,
	"vies_request_id" text,
	"vies_checked_at" timestamp with time zone,
	"decided_by_email" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "early_access_request_plan_known" CHECK (plan_wanted IN ('team', 'ai_plus', 'ai_max')),
	CONSTRAINT "early_access_request_status_known" CHECK (status IN ('open', 'granted', 'declined', 'converted')),
	CONSTRAINT "early_access_request_decision_shape" CHECK ((status = 'open') = (decided_at IS NULL AND decided_by_email IS NULL)),
	CONSTRAINT "early_access_request_vies_shape" CHECK (vies_valid IS NULL OR vies_checked_at IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "commerce_order" ADD COLUMN "vat_id_communicated" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "vat_id_status" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "vat_id" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "billing_state" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "customer_country" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "customer_state" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "payer_capacity" "payer_capacity";--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "vat_id_given" boolean;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "amount_eur_minor" integer;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "eur_rate" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "eur_rate_source" text;--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "factura_status" text;--> statement-breakpoint
ALTER TABLE "early_access_request" ADD CONSTRAINT "early_access_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_access_request" ADD CONSTRAINT "early_access_request_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "early_access_request_org_idx" ON "early_access_request" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "early_access_request_status_idx" ON "early_access_request" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "early_access_request_one_open_per_org" ON "early_access_request" USING btree ("organization_id") WHERE status = 'open';--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_vat_id_status_known" CHECK (vat_id_status IS NULL OR vat_id_status IN ('given', 'not_given'));--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_vat_id_only_when_given" CHECK (vat_id IS NULL OR vat_id_status = 'given');--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_factura_status_known" CHECK (factura_status IS NULL OR factura_status IN ('pending', 'issued', 'failed'));--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_eur_amount_has_rate" CHECK (amount_eur_minor IS NULL OR (eur_rate IS NOT NULL AND eur_rate_source IS NOT NULL));