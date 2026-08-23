-- 0141: Better Auth 1.7 account identity — add `issuer`, backfill it, then key accounts on the
-- unique pair (issuer, account_id).
--
-- ── Why this file is hand-split ──
--
-- drizzle-kit generated exactly two statements from the schema:
--
--   ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL;
--   CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer","account_id");
--
-- The first fails on a populated table, correctly — Postgres will not add a NOT NULL column with
-- no default — and there is no sane default to give it, because the right value depends on WHICH
-- provider each row belongs to. Better Auth's upgrade guide prescribes the split below, and its
-- CLI explicitly does not do the backfill: "it does not choose issuers".
--
-- The generated snapshot (meta/0141_snapshot.json) is kept as-is: it describes the END state, which
-- is what this file arrives at. Only the SQL is re-ordered.
--
-- Each migration runs in one transaction, so any RAISE below rolls the whole thing back and the
-- column is never left half-populated. That is why this is one file and not three.
--
-- ── What `issuer` means, and why the map is written out ──
--
-- 1.7 recognises an external account by a TRUSTED issuer plus the provider-side account id, rather
-- than by the local `provider_id`. `provider_id` is unchanged and still names our local provider
-- configuration; `account_id` is still the provider-side identifier. An OIDC provider contributes
-- its real issuer URL; a plain OAuth2 provider has none, so the guide specifies the synthetic form
-- `local:oauth:<encodeURIComponent(provider_id)>`.
--
-- The map is enumerated and the unmapped case RAISES, deliberately. A catch-all would quietly stamp
-- a synthetic issuer onto a provider that has a real one, and the failure mode of a wrong issuer is
-- that a user's existing link stops resolving — invisible, and per-user. Better to refuse and be
-- told which provider_id nobody mapped.
--
--   google     → https://accounts.google.com    OIDC; the issuer the guide names
--   github     → local:oauth:github             OAuth2, no issuer
--   bitbucket  → local:oauth:bitbucket          OAuth2, no issuer
--   gitlab     → local:oauth:gitlab             see the caveat
--
-- gitlab is the one judgement call. It is configured through the generic-OAuth plugin with explicit
-- authorization/token/userinfo URLs and NO discoveryUrl, which makes it plain OAuth2 by 1.7's test.
-- But it also requests the `openid` scope, and a self-hosted GitLab is a real OIDC authority, so a
-- deployment that switches it to discovery must use that instance's issuer URL instead. Repairable
-- rather than catastrophic: `provider_id` is retained, so a wrong guess is one UPDATE to correct.
--
-- There is no credential branch: `emailAndPassword` is disabled (lib/auth/index.ts), so this table
-- holds only linked OAuth accounts. That removes the guide's most dangerous case, where credential
-- rows need `account_id` rewritten to the linked user's id.

ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint

DO $$
DECLARE unmapped text;
BEGIN
  SELECT string_agg(DISTINCT "provider_id", ', ')
    INTO unmapped
    FROM "account"
   WHERE "provider_id" NOT IN ('google', 'github', 'bitbucket', 'gitlab');
  IF unmapped IS NOT NULL THEN
    RAISE EXCEPTION
      'account.issuer backfill has no mapping for provider_id(s): %. Add them to migration 0141 — do not let a catch-all invent an issuer.',
      unmapped;
  END IF;
END $$;--> statement-breakpoint

UPDATE "account"
   SET "issuer" = CASE "provider_id"
     WHEN 'google'    THEN 'https://accounts.google.com'
     WHEN 'github'    THEN 'local:oauth:github'
     WHEN 'bitbucket' THEN 'local:oauth:bitbucket'
     WHEN 'gitlab'    THEN 'local:oauth:gitlab'
   END
 WHERE "issuer" IS NULL;--> statement-breakpoint

-- Prove the backfill before trusting it. Two silent failure modes:
--   1. a row left NULL — SET NOT NULL would reject it with a far less useful message;
--   2. a duplicate (issuer, account_id). Uniqueness is GLOBAL in 1.7, not per-user, so if the same
--      provider account is linked to two users the pair collides. The guide is explicit that this
--      must stop the migration and be resolved from trusted provider data, never by matching on
--      email. Report the colliding keys so that work starts from facts rather than a failed index.
DO $$
DECLARE missing bigint;
        collisions text;
BEGIN
  SELECT count(*) INTO missing FROM "account" WHERE "issuer" IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'account.issuer backfill left % row(s) NULL', missing;
  END IF;

  SELECT string_agg(format('(%s, %s) x%s across %s user(s)', i, a, c, u), '; ')
    INTO collisions
    FROM (
      SELECT "issuer" AS i, "account_id" AS a, count(*) AS c, count(DISTINCT "user_id") AS u
        FROM "account"
       GROUP BY "issuer", "account_id"
      HAVING count(*) > 1
    ) dupes;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION
      'account identity collisions block the unique index: %. Resolve each from trusted provider data before re-running — never merge users by matching email.',
      collisions;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint

-- Better Auth derives this exact name from the model and looks for it; a differently-named index
-- would leave it believing the constraint is absent.
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");
