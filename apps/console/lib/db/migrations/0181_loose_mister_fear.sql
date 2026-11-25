-- 0181: Paddle Billing L1 — the provider seam's schema (billing_provider + Paddle ids beside Stripe's,
-- a per-provider webhook ledger, the paddle_transaction mirror and the usage_charge overage ledger).
--
-- ── Why two statements are hand-edited ──
--
-- drizzle-kit generated every statement below and the snapshot (meta/0181_snapshot.json) is kept as
-- generated, since it describes the end state. One defect in drizzle-kit's output needed fixing, per
-- 0141's, 0150's, 0153's and 0173's convention of documenting a hand edit here: the webhook ledger's
-- primary key moves from (event_id) to (provider, event_id), and drizzle-kit 0.31 cannot name the old
-- key, so it emitted the DROP as a commented-out placeholder AND placed the new composite key BEFORE
-- the `provider` column it is built on — as generated, the migration could not run. So:
--   · the placeholder is replaced by the real DROP of "stripe_webhook_event_pkey" — the name Postgres
--     gave the column-level PRIMARY KEY that 0056 created (no explicit name), the same on every
--     install, and NOT `IF EXISTS`: a database where it is named differently must stop here, not end
--     up with two keys;
--   · the ADD PRIMARY KEY is moved to just after `ADD COLUMN "provider"`.
-- Every existing ledger row takes `provider = 'stripe'` from the column default before the key is
-- rebuilt, so the new key is unique exactly where the old one was.
--
-- The migration runs in ONE transaction: the column, the key swap and everything else land together
-- or not at all.
CREATE TABLE "paddle_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"paddle_transaction_id" text NOT NULL,
	"paddle_subscription_id" text,
	"paddle_customer_id" text,
	"status" text NOT NULL,
	"origin" text,
	"currency" text NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"invoice_number" text,
	"billing_period_start" timestamp with time zone,
	"billing_period_end" timestamp with time zone,
	"billed_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"chargeback_at" timestamp with time zone,
	"custom_data" jsonb,
	"event_occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paddle_transaction_paddleTransactionId_unique" UNIQUE("paddle_transaction_id"),
	CONSTRAINT "paddle_transaction_status_known" CHECK (status IN ('draft', 'ready', 'billed', 'paid', 'completed', 'canceled', 'past_due'))
);
--> statement-breakpoint
CREATE TABLE "usage_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subscription_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"overage_minutes" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"provider_ref" text,
	"error" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_charge_period_sequence_unique" UNIQUE("provider","subscription_id","period_start","sequence"),
	CONSTRAINT "usage_charge_provider_known" CHECK (provider IN ('stripe', 'paddle')),
	CONSTRAINT "usage_charge_status_known" CHECK (status IN ('claimed', 'posted', 'reconciled', 'failed', 'waived')),
	CONSTRAINT "usage_charge_amounts_non_negative" CHECK (overage_minutes >= 0 AND amount_minor >= 0),
	CONSTRAINT "usage_charge_sequence_non_negative" CHECK (sequence >= 0),
	CONSTRAINT "usage_charge_period_ordered" CHECK (period_end > period_start)
);
--> statement-breakpoint
ALTER TABLE "ai_credit_grant" ADD COLUMN "paddle_transaction_id" text;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD COLUMN "provider" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD COLUMN "paddle_transaction_id" text;--> statement-breakpoint
ALTER TABLE "commerce_order" ADD COLUMN "paddle_subscription_id" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "billing_provider" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "paddle_customer_id" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "paddle_business_id" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "paddle_address_id" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "paddle_subscription_id" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "paddle_subscription_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "ai_paddle_subscription_id" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "ai_paddle_subscription_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "cancel_effective_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stripe_webhook_event" ADD COLUMN "provider" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_webhook_event" DROP CONSTRAINT "stripe_webhook_event_pkey";--> statement-breakpoint
ALTER TABLE "stripe_webhook_event" ADD CONSTRAINT "stripe_webhook_event_provider_event_id_pk" PRIMARY KEY("provider","event_id");--> statement-breakpoint
ALTER TABLE "paddle_transaction" ADD CONSTRAINT "paddle_transaction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_charge" ADD CONSTRAINT "usage_charge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paddle_transaction_org_idx" ON "paddle_transaction" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "paddle_transaction_subscription_idx" ON "paddle_transaction" USING btree ("paddle_subscription_id");--> statement-breakpoint
CREATE INDEX "usage_charge_org_idx" ON "usage_charge" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "commerce_order_paddle_subscription_idx" ON "commerce_order" USING btree ("paddle_subscription_id");--> statement-breakpoint
CREATE INDEX "organization_billing_paddle_customer_idx" ON "organization_billing" USING btree ("paddle_customer_id");--> statement-breakpoint
ALTER TABLE "ai_credit_grant" ADD CONSTRAINT "ai_credit_grant_paddle_transaction_id_unique" UNIQUE("paddle_transaction_id");--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_paddleBusinessId_unique" UNIQUE("paddle_business_id");--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_paddleSubscriptionId_unique" UNIQUE("paddle_subscription_id");--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_aiPaddleSubscriptionId_unique" UNIQUE("ai_paddle_subscription_id");--> statement-breakpoint
ALTER TABLE "ai_credit_grant" ADD CONSTRAINT "ai_credit_grant_at_most_one_ref" CHECK (num_nonnulls(stripe_ref, paddle_transaction_id) <= 1);--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_provider_known" CHECK (provider IN ('stripe', 'paddle'));--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_stripe_ids_are_stripe" CHECK ((stripe_subscription_id IS NULL AND stripe_payment_intent_id IS NULL) OR provider = 'stripe');--> statement-breakpoint
ALTER TABLE "commerce_order" ADD CONSTRAINT "commerce_order_paddle_ids_are_paddle" CHECK ((paddle_transaction_id IS NULL AND paddle_subscription_id IS NULL) OR provider = 'paddle');--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_provider_known" CHECK (billing_provider IS NULL OR billing_provider IN ('stripe', 'paddle'));--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_stripe_sub_is_stripe" CHECK ((stripe_subscription_id IS NULL AND ai_stripe_subscription_id IS NULL) OR billing_provider IS NULL OR billing_provider = 'stripe');--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_paddle_sub_is_paddle" CHECK ((paddle_subscription_id IS NULL AND ai_paddle_subscription_id IS NULL) OR billing_provider = 'paddle');--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_one_plan_subscription" CHECK (stripe_subscription_id IS NULL OR paddle_subscription_id IS NULL);--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_one_ai_subscription" CHECK (ai_stripe_subscription_id IS NULL OR ai_paddle_subscription_id IS NULL);--> statement-breakpoint
ALTER TABLE "stripe_webhook_event" ADD CONSTRAINT "stripe_webhook_event_provider_known" CHECK (provider IN ('stripe', 'paddle'));