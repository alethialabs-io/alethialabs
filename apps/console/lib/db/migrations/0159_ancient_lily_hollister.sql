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
-- per-environment; the rule is the same everywhere:
--   - the row kept is the OLDEST (created_at, then id), so the membership keeps its join date;
--   - its role becomes the MOST-PRIVILEGED one any of the rows held (owner > admin > operator >
--     viewer; better-auth's `member` is viewer; a comma-joined value ranks by its best part — the
--     reading lib/authz/org-access-control.ts `toPdpRole` gives it). The stored text of that row is
--     kept as it is;
--   - its status is `active` when ANY of the rows was active, else the oldest row's status;
--   - the other rows are deleted. No foreign key references member.id.
-- The PDP authorizes from `grants`, which is keyed on (org, user), not on the member row. For each
-- merged pair that ends up active with a role that maps, its org-wide role grant is rewritten to the
-- merged role — what `ensureMemberGrant` writes — and only when that role row exists, so a grant is
-- never removed without its replacement. Scoped grants and permission-key grants/denies are untouched.
-- The OpenFGA mirror is not reached from SQL; `ensureMemberGrant` resyncs it on the member's next
-- role change.
WITH "ranked" AS (
	SELECT "m"."id", "m"."organization_id", "m"."user_id", "m"."role", "m"."status", "m"."created_at",
		COALESCE((
			SELECT max(CASE btrim("part")
				WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'operator' THEN 2
				WHEN 'viewer' THEN 1 WHEN 'member' THEN 1 ELSE 0 END)
			FROM unnest(string_to_array("m"."role", ',')) AS "part"
		), 0) AS "rank"
	FROM "member" "m"
	WHERE ("m"."organization_id", "m"."user_id") IN (
		SELECT "organization_id", "user_id" FROM "member" GROUP BY 1, 2 HAVING count(*) > 1
	)
), "merged" AS (
	SELECT DISTINCT ON ("organization_id", "user_id")
		"organization_id",
		"user_id",
		first_value("id") OVER "oldest" AS "keep_id",
		first_value("role") OVER "best" AS "role",
		CASE WHEN bool_or("status" = 'active') OVER "pair" THEN 'active'
			ELSE first_value("status") OVER "oldest" END AS "status",
		CASE max("rank") OVER "pair"
			WHEN 4 THEN '00000000-0000-4000-8000-000000000001'::uuid
			WHEN 3 THEN '00000000-0000-4000-8000-000000000002'::uuid
			WHEN 2 THEN '00000000-0000-4000-8000-000000000003'::uuid
			WHEN 1 THEN '00000000-0000-4000-8000-000000000004'::uuid
		END AS "grant_role_id"
	FROM "ranked"
	WINDOW "pair" AS (PARTITION BY "organization_id", "user_id"),
		"oldest" AS (PARTITION BY "organization_id", "user_id" ORDER BY "created_at", "id"),
		"best" AS (PARTITION BY "organization_id", "user_id" ORDER BY "rank" DESC, "created_at", "id")
), "kept" AS (
	UPDATE "member" SET "role" = "merged"."role", "status" = "merged"."status"
	  FROM "merged"
	 WHERE "member"."id" = "merged"."keep_id"
	RETURNING "member"."id"
), "dropped" AS (
	DELETE FROM "member"
	 USING "merged"
	 WHERE "member"."organization_id" = "merged"."organization_id"
	   AND "member"."user_id" = "merged"."user_id"
	   AND "member"."id" <> "merged"."keep_id"
	RETURNING "member"."id"
), "regrant" AS (
	SELECT "merged".* FROM "merged"
	 WHERE "merged"."status" = 'active'
	   AND EXISTS (SELECT 1 FROM "role" WHERE "role"."id" = "merged"."grant_role_id")
), "revoked" AS (
	DELETE FROM "grants" "g"
	 USING "regrant"
	 WHERE "g"."org_id" = "regrant"."organization_id"
	   AND "g"."principal_type" = 'user'
	   AND "g"."principal_id" = "regrant"."user_id"
	   AND "g"."resource_type" = 'org'
	   AND "g"."resource_id" IS NULL
	   AND "g"."role_id" IS NOT NULL
	   AND "g"."effect" = 'allow'
	RETURNING "g"."id"
)
INSERT INTO "grants" ("org_id", "principal_type", "principal_id", "role_id", "resource_type")
SELECT "organization_id", 'user', "user_id", "grant_role_id", 'org' FROM "regrant";--> statement-breakpoint
-- #5445 member-merge: end
CREATE UNIQUE INDEX "member_organization_user_unique" ON "member" USING btree ("organization_id","user_id");