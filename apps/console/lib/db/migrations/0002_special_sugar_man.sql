CREATE TYPE "public"."billing_plan" AS ENUM('community', 'team', 'business', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."billing_status" AS ENUM('none', 'trialing', 'active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TABLE "organization_billing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan" "billing_plan" DEFAULT 'community' NOT NULL,
	"status" "billing_status" DEFAULT 'none' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"seats" integer,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_billing_organizationId_unique" UNIQUE("organization_id"),
	CONSTRAINT "organization_billing_stripeCustomerId_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "organization_billing_stripeSubscriptionId_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;