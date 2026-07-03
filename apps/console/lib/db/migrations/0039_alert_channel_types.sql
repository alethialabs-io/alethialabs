-- More alert-channel transports: Discord, Microsoft Teams, Mattermost, Google Chat
-- (incoming-webhook style) and PagerDuty (Events API v2 routing key). Custom migration
-- (db:generate is blocked by the pre-existing snapshot gap from the spec→project rename
-- — see 0035), matching the hand-authored ADD VALUE style of 0003.
ALTER TYPE "public"."alert_channel_type" ADD VALUE IF NOT EXISTS 'discord';--> statement-breakpoint
ALTER TYPE "public"."alert_channel_type" ADD VALUE IF NOT EXISTS 'teams';--> statement-breakpoint
ALTER TYPE "public"."alert_channel_type" ADD VALUE IF NOT EXISTS 'mattermost';--> statement-breakpoint
ALTER TYPE "public"."alert_channel_type" ADD VALUE IF NOT EXISTS 'googlechat';--> statement-breakpoint
ALTER TYPE "public"."alert_channel_type" ADD VALUE IF NOT EXISTS 'pagerduty';
