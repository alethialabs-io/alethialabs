CREATE TABLE "cli_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"release_notes" text DEFAULT '' NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"commit_sha" text,
	"github_release_url" text,
	"min_supported_version" text,
	"is_breaking" boolean DEFAULT false NOT NULL,
	CONSTRAINT "cli_releases_version_unique" UNIQUE("version")
);
