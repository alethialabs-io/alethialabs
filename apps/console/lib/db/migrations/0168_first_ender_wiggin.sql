DROP INDEX "payment_holds_open_payer_idx";--> statement-breakpoint
ALTER TABLE "payment_holds" ADD COLUMN "scope" text DEFAULT 'new_org' NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_holds_open_payer_idx" ON "payment_holds" USING btree ("scope","payer_key") WHERE state <> 'released';--> statement-breakpoint
ALTER TABLE "payment_holds" ADD CONSTRAINT "payment_holds_scope_known" CHECK (scope IN ('new_org', 'org_plan'));