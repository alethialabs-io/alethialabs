ALTER TABLE "grants" ALTER COLUMN "role_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "effect" text DEFAULT 'allow' NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "permission_key" text;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_permission_key_permission_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permission"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_grants_effect" ON "grants" USING btree ("org_id","principal_id","effect");