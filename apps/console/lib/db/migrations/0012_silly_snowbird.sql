CREATE TABLE "sso_provider" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"domain" text NOT NULL,
	"provider_id" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"domain_verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sso_provider_providerId_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;