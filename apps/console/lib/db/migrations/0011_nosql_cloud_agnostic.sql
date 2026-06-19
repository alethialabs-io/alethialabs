ALTER TABLE "spec_nosql_tables" RENAME COLUMN "hash_key" TO "partition_key";--> statement-breakpoint
ALTER TABLE "spec_nosql_tables" RENAME COLUMN "hash_key_type" TO "partition_key_type";--> statement-breakpoint
ALTER TABLE "spec_nosql_tables" RENAME COLUMN "range_key" TO "sort_key";--> statement-breakpoint
ALTER TABLE "spec_nosql_tables" RENAME COLUMN "range_key_type" TO "sort_key_type";--> statement-breakpoint
ALTER TYPE "public"."nosql_billing_mode" RENAME VALUE 'PAY_PER_REQUEST' TO 'on_demand';--> statement-breakpoint
ALTER TYPE "public"."nosql_billing_mode" RENAME VALUE 'PROVISIONED' TO 'provisioned';--> statement-breakpoint
ALTER TYPE "public"."nosql_billing_mode" RENAME TO "nosql_capacity_mode";--> statement-breakpoint
ALTER TABLE "spec_nosql_tables" RENAME COLUMN "billing_mode" TO "capacity_mode";
