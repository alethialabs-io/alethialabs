ALTER TABLE "ai_usage_ledger" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD COLUMN "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD COLUMN "cost_micros" bigint;
