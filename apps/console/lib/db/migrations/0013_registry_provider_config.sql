ALTER TABLE "spec_container_registries" DROP COLUMN "image_tag_mutability";--> statement-breakpoint
ALTER TABLE "spec_container_registries" DROP COLUMN "scan_on_push";--> statement-breakpoint
DROP TYPE "public"."registry_tag_mutability";
