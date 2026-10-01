CREATE TYPE "public"."kubeconfig_mint_shape" AS ENUM('exec', 'static');--> statement-breakpoint
CREATE TYPE "public"."kubeconfig_mint_status" AS ENUM('pending', 'ready', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."kubeconfig_mint_tier" AS ENUM('readonly', 'admin');--> statement-breakpoint
ALTER TYPE "public"."provision_job_type" ADD VALUE 'MINT_KUBECONFIG';--> statement-breakpoint
CREATE TABLE "kubeconfig_mint_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"job_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"tier" "kubeconfig_mint_tier" NOT NULL,
	"ttl_seconds" integer NOT NULL,
	"shape" "kubeconfig_mint_shape" NOT NULL,
	"client_public_key" text NOT NULL,
	"sealed_result" text,
	"failure_reason" text,
	"status" "kubeconfig_mint_status" DEFAULT 'pending' NOT NULL,
	"private_endpoint" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "kubeconfig_mint_requests_ttl_range" CHECK ("kubeconfig_mint_requests"."ttl_seconds" BETWEEN 900 AND 28800),
	CONSTRAINT "kubeconfig_mint_requests_public_key_shape" CHECK ("kubeconfig_mint_requests"."client_public_key" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "kubeconfig_mint_requests_sealed_iff_ready" CHECK (("kubeconfig_mint_requests"."status" = 'ready') = ("kubeconfig_mint_requests"."sealed_result" IS NOT NULL)),
	CONSTRAINT "kubeconfig_mint_requests_sealed_size" CHECK ("kubeconfig_mint_requests"."sealed_result" IS NULL OR length("kubeconfig_mint_requests"."sealed_result") <= 65536),
	CONSTRAINT "kubeconfig_mint_requests_reason_only_when_failed" CHECK ("kubeconfig_mint_requests"."failure_reason" IS NULL OR "kubeconfig_mint_requests"."status" = 'failed'),
	CONSTRAINT "kubeconfig_mint_requests_window" CHECK ("kubeconfig_mint_requests"."expires_at" > "kubeconfig_mint_requests"."created_at")
);
--> statement-breakpoint
ALTER TABLE "kubeconfig_mint_requests" ADD CONSTRAINT "kubeconfig_mint_requests_cluster_id_project_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."project_cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kubeconfig_mint_requests" ADD CONSTRAINT "kubeconfig_mint_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kubeconfig_mint_requests" ADD CONSTRAINT "kubeconfig_mint_requests_actor_user_id_profiles_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_kubeconfig_mint_requests_org" ON "kubeconfig_mint_requests" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_kubeconfig_mint_requests_cluster" ON "kubeconfig_mint_requests" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "idx_kubeconfig_mint_requests_expires" ON "kubeconfig_mint_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kubeconfig_mint_requests_job_id_key" ON "kubeconfig_mint_requests" USING btree ("job_id");