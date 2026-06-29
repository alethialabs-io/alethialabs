-- Better Auth's organization plugin runs with teams enabled, so it maps `teamId` on the
-- invitation model; the column was never added, 500ing invite-member. Add it (nullable —
-- invites without a team are NULL). Custom migration (db:generate blocked by the snapshot
-- gap — see 0040).
ALTER TABLE "invitation" ADD COLUMN IF NOT EXISTS "team_id" uuid;
