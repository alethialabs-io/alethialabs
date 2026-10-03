CREATE TABLE "pending_org_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"intended_name" text NOT NULL,
	"intended_slug" text NOT NULL,
	"billing" jsonb,
	"created_org_id" uuid,
	"linked_at" timestamp with time zone,
	"declared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_org_setups_subscription_id_unique" UNIQUE("subscription_id")
);
--> statement-breakpoint
ALTER TABLE "pending_org_setups" ADD CONSTRAINT "pending_org_setups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_org_setups" ADD CONSTRAINT "pending_org_setups_created_org_id_organization_id_fk" FOREIGN KEY ("created_org_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_org_setups_user_idx" ON "pending_org_setups" USING btree ("user_id","created_at");