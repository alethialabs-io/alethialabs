ALTER TABLE "ai_usage_ledger" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
-- BACKFILL, and it is not optional (#2683).
--
-- `settled_at IS NULL` means "this metered turn's provisional hold is still outstanding", and the
-- reconciler in lib/reconcile/ai-holds.ts releases such rows to 0 credits once they are older than
-- the window a turn can possibly take. ADD COLUMN leaves every EXISTING row NULL — so without this
-- statement the first sweep after deploy would look at the entire historical ledger, conclude that
-- every past charge was an unsettled hold, and zero it. That is not a leak, it is the destruction of
-- the billing record.
--
-- Stamped with `created_at` rather than `now()` because that is what actually happened: on the
-- insert path a row was settled at write time, and a reconciled hold was rewritten in place with no
-- separate settle timestamp to recover. Either way it is already settled, and dating it now would
-- misreport when.
--
-- A genuinely outstanding hold at deploy time is marked settled here and will never be swept. That
-- is deliberate: it leaves at most a handful of ≈$0.10 reservations to expire with their window,
-- which is the failure this change reduces, versus releasing real charges to zero, which is the
-- failure it must not cause. The sweep starts clean and only ever sees holds created after it existed.
UPDATE "ai_usage_ledger" SET "settled_at" = "created_at" WHERE "settled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_ai_usage_outstanding_holds" ON "ai_usage_ledger" USING btree ("created_at") WHERE settled_at IS NULL;
