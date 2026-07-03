ALTER TABLE "runners" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "target_release_id" uuid;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_target_release_id_runner_releases_id_fk" FOREIGN KEY ("target_release_id") REFERENCES "public"."runner_releases"("id") ON DELETE set null ON UPDATE no action;