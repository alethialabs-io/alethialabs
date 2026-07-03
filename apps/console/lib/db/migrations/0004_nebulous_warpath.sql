ALTER TABLE "spec_caches" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_caches" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_cluster" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_cluster" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_container_registries" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_container_registries" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_databases" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_databases" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_dns" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_dns" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_network" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_network" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_nosql_tables" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_nosql_tables" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_observability" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_observability" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_queues" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_queues" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_secrets" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_secrets" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_storage_buckets" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_storage_buckets" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_topics" ADD COLUMN "cloud_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_topics" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "spec_caches" ADD CONSTRAINT "spec_caches_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_cluster" ADD CONSTRAINT "spec_cluster_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_container_registries" ADD CONSTRAINT "spec_container_registries_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_databases" ADD CONSTRAINT "spec_databases_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_dns" ADD CONSTRAINT "spec_dns_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_network" ADD CONSTRAINT "spec_network_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_nosql_tables" ADD CONSTRAINT "spec_nosql_tables_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_observability" ADD CONSTRAINT "spec_observability_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_queues" ADD CONSTRAINT "spec_queues_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_secrets" ADD CONSTRAINT "spec_secrets_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_storage_buckets" ADD CONSTRAINT "spec_storage_buckets_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_topics" ADD CONSTRAINT "spec_topics_cloud_identity_id_cloud_identities_id_fk" FOREIGN KEY ("cloud_identity_id") REFERENCES "public"."cloud_identities"("id") ON DELETE set null ON UPDATE no action;