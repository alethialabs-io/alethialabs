CREATE TABLE "fleet_leader" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"holder" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_leader_singleton" CHECK ("fleet_leader"."singleton")
);
