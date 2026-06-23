CREATE TABLE "fleet_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "cloud_provider" NOT NULL,
	"name" text,
	"warm_min" integer DEFAULT 1 NOT NULL,
	"max" integer DEFAULT 10 NOT NULL,
	"slots_per_runner" integer DEFAULT 1 NOT NULL,
	"locations" text[] DEFAULT '{"fsn1"}' NOT NULL,
	"min_per_location" integer DEFAULT 0 NOT NULL,
	"surge" integer DEFAULT 1 NOT NULL,
	"buffer" integer DEFAULT 1 NOT NULL,
	"scale_down_grace_ticks" integer DEFAULT 5 NOT NULL,
	"version" text,
	"channel" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_fleet_pools_provider" ON "fleet_pools" USING btree ("provider");