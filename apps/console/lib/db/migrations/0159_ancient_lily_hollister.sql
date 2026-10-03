CREATE TABLE "pending_org_setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"intended_name" text NOT NULL,
	"intended_slug" text NOT NULL,
	"billing" jsonb,
	"created_org_id" uuid,
	"creating_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"declared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_org_setups_subscription_id_unique" UNIQUE("subscription_id")
);
--> statement-breakpoint
ALTER TABLE "pending_org_setups" ADD CONSTRAINT "pending_org_setups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_org_setups" ADD CONSTRAINT "pending_org_setups_created_org_id_organization_id_fk" FOREIGN KEY ("created_org_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_org_setups_user_idx" ON "pending_org_setups" USING btree ("user_id","created_at");--> statement-breakpoint
-- #5445 member-merge: begin
-- One membership per (organization, user) (#5445), so every pair holding more than one row is merged
-- into ONE row before the unique index is created. Nothing is refused and nothing is guessed at
-- per-environment. The merge is LEAST-PRIVILEGED (maintainer ruling, 2026-10-03):
--   - the row kept is the OLDEST (created_at, then id), so the membership keeps its join date;
--   - its role becomes the LOWEST-ranked role among the rows (owner > admin > operator > viewer, the
--     order of ORG_ROLES in lib/authz/org-access-control.ts; better-auth's `member` is viewer). A row
--     ranks by what it grants: a comma-joined value ranks by its best part, the reading `toPdpRole`
--     gives it. A row whose role maps to no PDP role grants nothing on its own and is passed over
--     unless every row of the pair is like that. The stored text of the lowest row is kept as it is;
--   - its status is `active` only when EVERY row was active; otherwise it is the status of the oldest
--     row that was not active;
--   - the other rows are deleted. No foreign key references member.id.
-- The one exception: an org is never left without an active owner. When no member of the org would
-- be an active owner after the merge, every merged pair of that org that held an owner row keeps the
-- role and status of its oldest owner row instead (setMemberSuspended refuses to suspend an owner, so
-- that row is active in practice).
-- The PDP authorizes from `grants`, keyed on (org, user), not on the member row. The merge only ever
-- LOWERS what those grants allow, never raises it:
--   - an active pair: each org-wide allow grant of a built-in role ranked ABOVE the merged role is
--     deleted, and the merged role's org-wide grant (what `ensureMemberGrant` writes) is inserted in
--     its place unless the user already holds it. Nothing happens when the replacement role row does
--     not exist, so a grant is never removed without its replacement. A grant at or below the merged
--     role, a custom-role grant, a scoped grant and every deny are untouched;
--   - a pair that ends up not active: every allow grant of the user in that org is deleted, which is
--     what suspending a member does (`revokeMemberGrant`) minus the denies, which only lower access.
-- The OpenFGA mirror is not reached from SQL and is NOT resynced here: it keeps the tuples it had
-- until `ensureMemberGrant` / `revokeMemberGrant` next runs for that member.
WITH "ranked" AS (
	SELECT "m"."id", "m"."organization_id", "m"."user_id", "m"."role", "m"."status", "m"."created_at",
		COALESCE((
			SELECT max(CASE btrim("part")
				WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'operator' THEN 2
				WHEN 'viewer' THEN 1 WHEN 'member' THEN 1 ELSE 0 END)
			FROM unnest(string_to_array("m"."role", ',')) AS "part"
		), 0) AS "rank",
		count(*) OVER (PARTITION BY "m"."organization_id", "m"."user_id") AS "copies"
	FROM "member" "m"
	WHERE "m"."organization_id" IN (
		SELECT "organization_id" FROM "member" GROUP BY "organization_id", "user_id" HAVING count(*) > 1
	)
), "pairs" AS (
	SELECT DISTINCT ON ("organization_id", "user_id")
		"organization_id",
		"user_id",
		first_value("id") OVER "oldest" AS "keep_id",
		first_value("role") OVER "lowest" AS "low_role",
		first_value("rank") OVER "lowest" AS "low_rank",
		CASE WHEN bool_and("status" = 'active') OVER "pair" THEN 'active'
			ELSE first_value("status") OVER "inactive_first" END AS "low_status",
		max("rank") OVER "pair" AS "high_rank",
		first_value("role") OVER "highest" AS "owner_role",
		first_value("status") OVER "highest" AS "owner_status"
	FROM "ranked"
	WHERE "copies" > 1
	WINDOW "pair" AS (PARTITION BY "organization_id", "user_id"),
		"oldest" AS (PARTITION BY "organization_id", "user_id" ORDER BY "created_at", "id"),
		"lowest" AS (PARTITION BY "organization_id", "user_id" ORDER BY "rank" = 0, "rank", "created_at", "id"),
		"inactive_first" AS (PARTITION BY "organization_id", "user_id" ORDER BY "status" = 'active', "created_at", "id"),
		"highest" AS (PARTITION BY "organization_id", "user_id" ORDER BY "rank" DESC, "created_at", "id")
), "owned" AS (
	-- Orgs that still have an active owner after a least-privileged merge.
	SELECT "organization_id" FROM "ranked" WHERE "copies" = 1 AND "rank" = 4 AND "status" = 'active'
	UNION
	SELECT "organization_id" FROM "pairs" WHERE "low_rank" = 4 AND "low_status" = 'active'
), "merged" AS (
	SELECT "p"."organization_id", "p"."user_id", "p"."keep_id",
		CASE WHEN "x"."keep_owner" THEN "p"."owner_role" ELSE "p"."low_role" END AS "role",
		CASE WHEN "x"."keep_owner" THEN "p"."owner_status" ELSE "p"."low_status" END AS "status",
		CASE WHEN "x"."keep_owner" THEN 4 ELSE "p"."low_rank" END AS "rank"
	FROM "pairs" "p"
	CROSS JOIN LATERAL (
		SELECT "p"."high_rank" = 4
			AND "p"."organization_id" NOT IN (SELECT "organization_id" FROM "owned") AS "keep_owner"
	) "x"
), "target" AS (
	SELECT "merged".*,
		CASE "merged"."rank"
			WHEN 4 THEN '00000000-0000-4000-8000-000000000001'::uuid
			WHEN 3 THEN '00000000-0000-4000-8000-000000000002'::uuid
			WHEN 2 THEN '00000000-0000-4000-8000-000000000003'::uuid
			WHEN 1 THEN '00000000-0000-4000-8000-000000000004'::uuid
		END AS "grant_role_id"
	FROM "merged"
), "kept" AS (
	UPDATE "member" SET "role" = "target"."role", "status" = "target"."status"
	  FROM "target"
	 WHERE "member"."id" = "target"."keep_id"
	RETURNING "member"."id"
), "dropped" AS (
	DELETE FROM "member"
	 USING "target"
	 WHERE "member"."organization_id" = "target"."organization_id"
	   AND "member"."user_id" = "target"."user_id"
	   AND "member"."id" <> "target"."keep_id"
	RETURNING "member"."id"
), "lowered" AS (
	DELETE FROM "grants" "g"
	 USING "target"
	 WHERE "target"."status" = 'active'
	   AND "target"."grant_role_id" IS NOT NULL
	   AND EXISTS (SELECT 1 FROM "role" WHERE "role"."id" = "target"."grant_role_id")
	   AND "g"."org_id" = "target"."organization_id"
	   AND "g"."principal_type" = 'user'
	   AND "g"."principal_id" = "target"."user_id"
	   AND "g"."resource_type" = 'org'
	   AND "g"."resource_id" IS NULL
	   AND "g"."effect" = 'allow'
	   AND (CASE "g"."role_id"
			WHEN '00000000-0000-4000-8000-000000000001'::uuid THEN 4
			WHEN '00000000-0000-4000-8000-000000000002'::uuid THEN 3
			WHEN '00000000-0000-4000-8000-000000000003'::uuid THEN 2
			WHEN '00000000-0000-4000-8000-000000000004'::uuid THEN 1
		END) > "target"."rank"
	RETURNING "g"."org_id", "g"."principal_id"
), "suspended" AS (
	DELETE FROM "grants" "g"
	 USING "target"
	 WHERE "target"."status" <> 'active'
	   AND "g"."org_id" = "target"."organization_id"
	   AND "g"."principal_type" = 'user'
	   AND "g"."principal_id" = "target"."user_id"
	   AND "g"."effect" = 'allow'
	RETURNING "g"."id"
)
INSERT INTO "grants" ("org_id", "principal_type", "principal_id", "role_id", "resource_type")
SELECT "target"."organization_id", 'user', "target"."user_id", "target"."grant_role_id", 'org'
  FROM "target"
 WHERE EXISTS (
		SELECT 1 FROM "lowered"
		 WHERE "lowered"."org_id" = "target"."organization_id"
		   AND "lowered"."principal_id" = "target"."user_id"
	)
   AND NOT EXISTS (
		SELECT 1 FROM "grants" "h"
		 WHERE "h"."org_id" = "target"."organization_id"
		   AND "h"."principal_type" = 'user'
		   AND "h"."principal_id" = "target"."user_id"
		   AND "h"."resource_type" = 'org'
		   AND "h"."resource_id" IS NULL
		   AND "h"."effect" = 'allow'
		   AND "h"."role_id" = "target"."grant_role_id"
	);--> statement-breakpoint
-- #5445 member-merge: end
CREATE UNIQUE INDEX "member_organization_user_unique" ON "member" USING btree ("organization_id","user_id");