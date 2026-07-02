ALTER TABLE "project_caches" DROP CONSTRAINT "project_caches_project_id_name_key";--> statement-breakpoint
ALTER TABLE "project_cluster" DROP CONSTRAINT "project_cluster_project_id_unique";--> statement-breakpoint
ALTER TABLE "project_container_registries" DROP CONSTRAINT "project_container_registries_project_id_name_key";--> statement-breakpoint
ALTER TABLE "project_databases" DROP CONSTRAINT "project_databases_project_id_name_key";--> statement-breakpoint
ALTER TABLE "project_dns" DROP CONSTRAINT "project_dns_project_id_unique";--> statement-breakpoint
ALTER TABLE "project_network" DROP CONSTRAINT "project_network_project_id_unique";--> statement-breakpoint
ALTER TABLE "project_nosql_tables" DROP CONSTRAINT "project_nosql_tables_project_id_name_key";--> statement-breakpoint
ALTER TABLE "project_observability" DROP CONSTRAINT "project_observability_project_id_unique";--> statement-breakpoint
ALTER TABLE "project_queues" DROP CONSTRAINT "project_queues_project_id_name_key";--> statement-breakpoint
ALTER TABLE "project_repositories" DROP CONSTRAINT "project_repositories_project_id_unique";--> statement-breakpoint
ALTER TABLE "project_secrets" DROP CONSTRAINT "project_secrets_project_id_name_key";--> statement-breakpoint
ALTER TABLE "project_storage_buckets" DROP CONSTRAINT "project_storage_buckets_project_id_name_key";--> statement-breakpoint
ALTER TABLE "project_topics" DROP CONSTRAINT "project_topics_project_id_name_key";--> statement-breakpoint
ALTER TABLE "project_caches" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_cluster" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_container_registries" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_databases" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_dns" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_git_credentials" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_network" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_nosql_tables" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_observability" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_queues" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_secrets" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_storage_buckets" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_topics" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_caches" ADD CONSTRAINT "project_caches_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cluster" ADD CONSTRAINT "project_cluster_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_container_registries" ADD CONSTRAINT "project_container_registries_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_databases" ADD CONSTRAINT "project_databases_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_dns" ADD CONSTRAINT "project_dns_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_git_credentials" ADD CONSTRAINT "project_git_credentials_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_network" ADD CONSTRAINT "project_network_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_nosql_tables" ADD CONSTRAINT "project_nosql_tables_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_observability" ADD CONSTRAINT "project_observability_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_queues" ADD CONSTRAINT "project_queues_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_storage_buckets" ADD CONSTRAINT "project_storage_buckets_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_topics" ADD CONSTRAINT "project_topics_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_caches" ADD CONSTRAINT "project_caches_project_id_environment_id_name_key" UNIQUE("project_id","environment_id","name");--> statement-breakpoint
ALTER TABLE "project_cluster" ADD CONSTRAINT "project_cluster_project_id_environment_id_key" UNIQUE("project_id","environment_id");--> statement-breakpoint
ALTER TABLE "project_container_registries" ADD CONSTRAINT "project_container_registries_project_id_environment_id_name_key" UNIQUE("project_id","environment_id","name");--> statement-breakpoint
ALTER TABLE "project_databases" ADD CONSTRAINT "project_databases_project_id_environment_id_name_key" UNIQUE("project_id","environment_id","name");--> statement-breakpoint
ALTER TABLE "project_dns" ADD CONSTRAINT "project_dns_project_id_environment_id_key" UNIQUE("project_id","environment_id");--> statement-breakpoint
ALTER TABLE "project_network" ADD CONSTRAINT "project_network_project_id_environment_id_key" UNIQUE("project_id","environment_id");--> statement-breakpoint
ALTER TABLE "project_nosql_tables" ADD CONSTRAINT "project_nosql_tables_project_id_environment_id_name_key" UNIQUE("project_id","environment_id","name");--> statement-breakpoint
ALTER TABLE "project_observability" ADD CONSTRAINT "project_observability_project_id_environment_id_key" UNIQUE("project_id","environment_id");--> statement-breakpoint
ALTER TABLE "project_queues" ADD CONSTRAINT "project_queues_project_id_environment_id_name_key" UNIQUE("project_id","environment_id","name");--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_environment_id_key" UNIQUE("project_id","environment_id");--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_project_id_environment_id_name_key" UNIQUE("project_id","environment_id","name");--> statement-breakpoint
ALTER TABLE "project_storage_buckets" ADD CONSTRAINT "project_storage_buckets_project_id_environment_id_name_key" UNIQUE("project_id","environment_id","name");--> statement-breakpoint
ALTER TABLE "project_topics" ADD CONSTRAINT "project_topics_project_id_environment_id_name_key" UNIQUE("project_id","environment_id","name");