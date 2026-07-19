ALTER TABLE "project_iac_sources" DROP CONSTRAINT "project_iac_sources_project_id_environment_id_key";--> statement-breakpoint
ALTER TABLE "project_iac_sources" ADD COLUMN "fabric_id" uuid;--> statement-breakpoint
ALTER TABLE "project_iac_sources" ADD CONSTRAINT "project_iac_sources_fabric_id_project_fabrics_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."project_fabrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_iac_sources" ADD CONSTRAINT "project_iac_sources_project_id_fabric_id_key" UNIQUE("project_id","fabric_id");