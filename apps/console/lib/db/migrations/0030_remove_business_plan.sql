-- Collapse the billing tiers to community / team / enterprise by dropping the
-- "business" plan. Its governance entitlements (custom roles, audit export, advanced
-- alerting) now belong to enterprise, so remap any business orgs up to enterprise
-- before narrowing the enum. Custom migration (db:generate is held off until the
-- pre-existing snapshot-history fork is reconciled) — matches the hand-authored style
-- of 0024–0029. Safe to re-run: drizzle's journal applies each migration once.
UPDATE "organization_billing" SET "plan" = 'enterprise' WHERE "plan" = 'business';--> statement-breakpoint
ALTER TABLE "organization_billing" ALTER COLUMN "plan" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "organization_billing" ALTER COLUMN "plan" SET DEFAULT 'community'::text;--> statement-breakpoint
DROP TYPE "public"."billing_plan";--> statement-breakpoint
CREATE TYPE "public"."billing_plan" AS ENUM('community', 'team', 'enterprise');--> statement-breakpoint
ALTER TABLE "organization_billing" ALTER COLUMN "plan" SET DEFAULT 'community'::"public"."billing_plan";--> statement-breakpoint
ALTER TABLE "organization_billing" ALTER COLUMN "plan" SET DATA TYPE "public"."billing_plan" USING "plan"::"public"."billing_plan";
