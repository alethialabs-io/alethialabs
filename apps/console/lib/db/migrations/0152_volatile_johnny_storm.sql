DROP INDEX "account_issuer_accountId_uidx";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "active_team_id" uuid;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "member_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_member" ADD COLUMN "membership_key" text;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_membershipKey_unique" UNIQUE("membership_key");