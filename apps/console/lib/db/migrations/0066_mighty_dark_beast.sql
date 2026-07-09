ALTER TABLE "organization_billing" ADD COLUMN "ai_tier" text DEFAULT 'ai_free' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "ai_stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "ai_subscription_status" "billing_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_aiStripeSubscriptionId_unique" UNIQUE("ai_stripe_subscription_id");