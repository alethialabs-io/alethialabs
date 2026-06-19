ALTER TABLE "spec_caches" ALTER COLUMN "node_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "spec_cluster" ALTER COLUMN "cluster_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "spec_cluster" ALTER COLUMN "instance_types" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "spec_databases" ALTER COLUMN "engine" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "spec_databases" ALTER COLUMN "engine_version" DROP DEFAULT;