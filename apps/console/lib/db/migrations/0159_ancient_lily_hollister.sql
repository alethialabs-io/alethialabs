CREATE TABLE "pending_org_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"intended_name" text NOT NULL,
	"intended_slug" text NOT NULL,
	"billing" jsonb,
	"created_org_id" uuid,
	"creating_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"declared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_org_setups_subscription_id_unique" UNIQUE("subscription_id")
);
--> statement-breakpoint
ALTER TABLE "pending_org_setups" ADD CONSTRAINT "pending_org_setups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_org_setups" ADD CONSTRAINT "pending_org_setups_created_org_id_organization_id_fk" FOREIGN KEY ("created_org_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_org_setups_user_idx" ON "pending_org_setups" USING btree ("user_id","created_at");--> statement-breakpoint
-- One membership per (organization, user) (#5445). Rows that are EXACT copies (same role, same
-- status) carry nothing the oldest one does not, so the newer copies go. Copies that DISAGREE on role or
-- status are not guessed at: the migration stops and names how many there are, for an operator to
-- resolve, rather than deleting a role or a suspension.
DELETE FROM "member" "m"
 USING "member" "keep"
 WHERE "keep"."organization_id" = "m"."organization_id"
   AND "keep"."user_id" = "m"."user_id"
   AND "keep"."role" = "m"."role"
   AND "keep"."status" = "m"."status"
   AND ("keep"."created_at", "keep"."id") < ("m"."created_at", "m"."id");--> statement-breakpoint
DO $$
DECLARE conflicting integer;
BEGIN
  SELECT count(*) INTO conflicting FROM (
    SELECT 1 FROM "member" GROUP BY "organization_id", "user_id" HAVING count(*) > 1
  ) "d";
  IF conflicting > 0 THEN
    RAISE EXCEPTION 'member: % (organization_id, user_id) pair(s) have more than one row with different roles or statuses; resolve them before migration 0159 (#5445)', conflicting;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "member_organization_user_unique" ON "member" USING btree ("organization_id","user_id");