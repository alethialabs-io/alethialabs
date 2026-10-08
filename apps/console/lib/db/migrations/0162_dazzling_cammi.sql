ALTER TABLE "pending_org_setups" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_org_setups" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "pending_org_setups" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "pending_org_setups" ADD COLUMN "closed_note" text;--> statement-breakpoint
ALTER TABLE "pending_org_setups" ADD COLUMN "refused_reason" text;--> statement-breakpoint
CREATE INDEX "pending_org_setups_open_org_idx" ON "pending_org_setups" USING btree ("created_org_id") WHERE linked_at IS NULL AND closed_at IS NULL;