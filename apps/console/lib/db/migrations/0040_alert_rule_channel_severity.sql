-- Per-channel severity routing: a policy's channel binding can deliver only events at or
-- above a severity floor (null = all). Refines routing on top of the rule-level match.
-- Custom migration (db:generate is blocked by the pre-existing snapshot gap from the
-- spec→project rename — see 0035), matching the hand-authored style.
ALTER TABLE "alert_rule_channels" ADD COLUMN IF NOT EXISTS "min_severity" "alert_severity";
