ALTER TABLE "spec_cluster" DROP COLUMN "cluster_arn";--> statement-breakpoint
ALTER TABLE "spec_cluster" ADD COLUMN "provider_outputs" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "spec_databases" DROP COLUMN "cluster_identifier";--> statement-breakpoint
ALTER TABLE "spec_databases" DROP COLUMN "cluster_arn";--> statement-breakpoint
ALTER TABLE "spec_databases" DROP COLUMN "master_credentials_secret_arn";--> statement-breakpoint
ALTER TABLE "spec_databases" DROP COLUMN "extra_credentials_secret_arn";--> statement-breakpoint
ALTER TABLE "spec_databases" DROP COLUMN "credentials_kms_key_arn";--> statement-breakpoint
ALTER TABLE "spec_databases" ADD COLUMN "provider_outputs" jsonb DEFAULT '{}'::jsonb;
