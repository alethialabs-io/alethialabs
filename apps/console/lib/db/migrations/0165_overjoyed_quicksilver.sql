CREATE TABLE "purchase_leases" (
	"key" text PRIMARY KEY NOT NULL,
	"holder" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
