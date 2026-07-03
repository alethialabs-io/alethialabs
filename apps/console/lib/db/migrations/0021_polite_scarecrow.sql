CREATE TABLE "oauth_access_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_expires_at" timestamp with time zone NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid,
	"scopes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_access_token_accessToken_unique" UNIQUE("access_token"),
	CONSTRAINT "oauth_access_token_refreshToken_unique" UNIQUE("refresh_token")
);
--> statement-breakpoint
CREATE TABLE "oauth_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"metadata" text,
	"client_id" text NOT NULL,
	"client_secret" text,
	"redirect_urls" text NOT NULL,
	"type" text NOT NULL,
	"disabled" boolean DEFAULT false,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_application_clientId_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scopes" text,
	"consent_given" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_application" ADD CONSTRAINT "oauth_application_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;